"use strict";

import assert from "node:assert/strict";
import test from "node:test";
import type {LightCommandMessage} from "../lib/light-contract";
import {
  normaliseZ2mLightConfig,
  parseZ2mTargetTopics,
  transitionZ2mLight,
  z2mLightPayload,
  type Z2mLightState
} from "../lib/z2m-light-adapter";

const config = normaliseZ2mLightConfig({target: "ceiling", baseTopic: "z2m", friendlyName: "test-light"});
const group = {...config, group: true};
const at = (seconds: number) => new Date(Date.parse("2026-11-27T12:00:00Z") + seconds * 1000);
const command = (fields: Partial<LightCommandMessage>): {light: LightCommandMessage} =>
  ({light: {kind: "command", target: "ceiling", state: "ON", source: "motion", id: "c1", ...fields}});

test("commands become Zigbee2MQTT's /set payloads, field for field and in the order the room built them before 6.0", () => {
  // Styled: brightness, colour temperature, then the transition.
  assert.equal(JSON.stringify(z2mLightPayload(command({brightnessPct: 25, colorTempKelvin: 2500, transitionSeconds: 1}).light)),
    '{"state":"ON","brightness":64,"color_temp":400,"transition":1}');
  // An intent's other fields come first, as they did; an intent's own transition stays where it was.
  assert.equal(JSON.stringify(z2mLightPayload(command({extra: {effect: "blink"}, brightnessPct: 100, transitionSeconds: 1}).light)),
    '{"state":"ON","effect":"blink","brightness":254,"transition":1}');
  assert.equal(JSON.stringify(z2mLightPayload(command({extra: {transition: 3, effect: "okay"}, colorTempKelvin: 6500, transitionSeconds: 1}).light)),
    '{"state":"ON","transition":3,"effect":"okay","color_temp":154}');
  assert.equal(JSON.stringify(z2mLightPayload(command({state: "OFF", brightnessPct: 50}).light)), '{"state":"OFF"}');
  assert.equal(JSON.stringify(z2mLightPayload(command({}).light)), '{"state":"ON"}');
  // 0 % is the dimmest, not off; rounding as before (a mired of exactly n.5 rounds up).
  assert.equal(z2mLightPayload(command({brightnessPct: 0}).light).brightness, 1);
  assert.equal(z2mLightPayload(command({colorTempKelvin: 2000}).light).color_temp, 500);

  const sent = transitionZ2mLight(undefined, command({brightnessPct: 25}), config, at(0));
  assert.deepEqual(sent.publications, [{topic: "z2m/test-light/set", payload: {state: "ON", brightness: 64}, retain: false}]);
  assert.deepEqual(sent.readings, []);
  // Another light's command: nothing at all.
  const other = transitionZ2mLight(sent.state, {light: {...command({}).light, target: "lamp"}}, config, at(1));
  assert.deepEqual([other.publications, other.readings, other.ignored], [[], [], true]);
});

test("reports become readings: neutral values, the fields it reports, and whether it shows the last command", () => {
  let state = transitionZ2mLight(undefined, command({brightnessPct: 25, colorTempKelvin: 2500, transitionSeconds: 1}), config, at(0)).state;
  const report = (payload: unknown, seconds: number) => transitionZ2mLight(state, {topic: "z2m/test-light", payload: JSON.stringify(payload)}, config, at(seconds));
  let result = report({state: "ON", brightness: 64, color_temp: 400, linkquality: 80}, 1);
  assert.deepEqual(result.readings, [{kind: "observed", target: "ceiling", on: true, brightnessPct: 64 * 100 / 254, colorTempKelvin: 2500,
    fields: ["brightness", "colorTemp"], showsLast: true, observedAt: at(1).toISOString()}]);
  state = result.state;
  result = report({state: "ON", brightness: 120, color_temp: 400}, 2);
  assert.equal((result.readings[0] as {showsLast: boolean}).showsLast, false, "someone else's level");
  // An on/off-only light reports no values at all.
  const plain = transitionZ2mLight(undefined, {topic: "z2m/test-light", payload: {state: "OFF"}}, config, at(3));
  assert.deepEqual(plain.readings, [{kind: "observed", target: "ceiling", on: false, fields: [], showsLast: false, observedAt: at(3).toISOString()}]);
  assert.deepEqual(transitionZ2mLight(undefined, {topic: "z2m/test-light", payload: {linkquality: 3}}, config, at(3)).readings, [], "no state");
});

test("only the room's restyles are skipped when the light already shows them, answered with the last report's time and no echo entry", () => {
  let state = transitionZ2mLight(undefined, {topic: "z2m/test-light", payload: {state: "ON", brightness: 64, color_temp: 400}}, config, at(0)).state;
  const restyle = transitionZ2mLight(state, command({brightnessPct: 25, colorTempKelvin: 2500, transitionSeconds: 60, restyle: true, id: "r1"}), config, at(30));
  assert.deepEqual(restyle.publications, []);
  assert.deepEqual(restyle.readings, [{kind: "skipped", target: "ceiling", id: "r1", observedAt: at(0).toISOString()}]);
  assert.deepEqual(restyle.state.expected, [], "nothing to wait for");
  // The same values not as a restyle (an intent, or a restyle after someone else's bare ON): always sent.
  const intent = transitionZ2mLight(state, command({brightnessPct: 25, colorTempKelvin: 2500, transitionSeconds: 1, id: "i1"}), config, at(30));
  assert.equal(intent.publications.length, 1);
  // A restyle to a different level, or of a light that is off, is sent.
  assert.equal(transitionZ2mLight(state, command({brightnessPct: 30, colorTempKelvin: 2500, transitionSeconds: 60, restyle: true}), config, at(30)).publications.length, 1);
  state = transitionZ2mLight(state, {topic: "z2m/test-light", payload: {state: "OFF", brightness: 64, color_temp: 400}}, config, at(31)).state;
  assert.equal(transitionZ2mLight(state, command({brightnessPct: 25, colorTempKelvin: 2500, transitionSeconds: 60, restyle: true}), config, at(32)).publications.length, 1);
});

test("its own echo is its own; a bare ON or OFF changed on the way is its own; anything else is someone else's", () => {
  const sent = transitionZ2mLight(undefined, command({brightnessPct: 25, transitionSeconds: 1, id: "c7"}), config, at(0));
  const seen = (state: Z2mLightState, payload: unknown, seconds: number, extra: Record<string, unknown> = {}) =>
    transitionZ2mLight(state, {topic: "z2m/test-light/set", payload: JSON.stringify(payload), ...extra}, config, at(seconds));
  // Exact, then the same again (a duplicate delivery): ours both times.
  let result = seen(sent.state, {transition: 1, brightness: 64, state: "ON"}, 0.1);
  assert.deepEqual(result.readings, []);
  assert.deepEqual(seen(result.state, {state: "ON", brightness: 64, transition: 1}, 0.2).readings, []);
  // Cut to a bare ON on the way: ours, changed.
  result = seen(sent.state, {state: "ON"}, 0.1);
  assert.deepEqual(result.readings, [{kind: "echo-changed", target: "ceiling", id: "c7", state: "ON"}]);
  // Any ON while its own ON hasn't come back counts as its own, changed, as the room's rule always was.
  assert.equal(seen(sent.state, {state: "ON", brightness: 10}, 0.1).readings[0]?.kind, "echo-changed");
  // Someone else's: once its own has come back, with values or bare; a different power; or after the window.
  const echoed = seen(sent.state, {state: "ON", brightness: 64, transition: 1}, 0.1).state;
  assert.deepEqual(seen(echoed, {state: "ON", brightness: 10}, 0.2).readings,
    [{kind: "external", target: "ceiling", state: "ON", setsValues: true, observedAt: at(0.2).toISOString()}]);
  assert.deepEqual(seen(sent.state, {state: "OFF"}, 0.1).readings[0], {kind: "external", target: "ceiling", state: "OFF", setsValues: false, observedAt: at(0.1).toISOString()});
  assert.equal(seen(sent.state, {state: "ON"}, 6).readings[0]?.kind, "external", "after the 5-second window");
  assert.deepEqual(seen(sent.state, {state: "ON", brightness: 10}, 0.1, {retain: true}).readings, [], "retained: ignored");
});

test("availability is passed on; a group has none, and answers observe with its last state rather than /get", () => {
  const online = transitionZ2mLight(undefined, {topic: "z2m/test-light/availability", payload: '{"state":"offline"}'}, config, at(0));
  assert.deepEqual(online.readings, [{kind: "availability", target: "ceiling", online: false}]);
  assert.deepEqual(transitionZ2mLight(undefined, {topic: "z2m/test-light/availability", payload: "online"}, config, at(0)).readings,
    [{kind: "availability", target: "ceiling", online: true}]);
  assert.deepEqual(transitionZ2mLight(undefined, {light: {kind: "observe", target: "ceiling"}}, config, at(0)).publications,
    [{topic: "z2m/test-light/get", payload: {state: ""}, retain: false}]);

  // A group: the same commands; no /get; no availability; its state (Zigbee2MQTT's own) as a reading.
  const groupCommand = transitionZ2mLight(undefined, command({brightnessPct: 25}), group, at(0));
  assert.deepEqual(groupCommand.publications, [{topic: "z2m/test-light/set", payload: {state: "ON", brightness: 64}, retain: false}]);
  assert.deepEqual(transitionZ2mLight(undefined, {light: {kind: "observe", target: "ceiling"}}, group, at(0)), {
    state: transitionZ2mLight(undefined, {}, group, at(0)).state, publications: [], readings: [],
    traces: [{event: "observe", outcome: "answered", reason: "group-has-no-get", details: {}}], ignored: false});
  const reported = transitionZ2mLight(groupCommand.state, {topic: "z2m/test-light", payload: {state: "ON", brightness: 64}}, group, at(0.05));
  assert.equal((reported.readings[0] as {showsLast: boolean}).showsLast, true, "Zigbee2MQTT's own group state follows the command at once");
  assert.deepEqual(transitionZ2mLight(reported.state, {light: {kind: "observe", target: "ceiling"}}, group, at(1)).readings.map(({kind}) => kind), ["observed"]);
  assert.deepEqual(transitionZ2mLight(undefined, {topic: "z2m/test-light/availability", payload: "offline"}, group, at(0)).readings, []);
});

test("settings, and reading a 5.x room target's topics", () => {
  assert.throws(() => normaliseZ2mLightConfig({friendlyName: "x"}), /target is required/);
  assert.throws(() => normaliseZ2mLightConfig({target: "a", friendlyName: ""}), /friendly name is required/);
  assert.throws(() => normaliseZ2mLightConfig({target: "a", friendlyName: "x/#"}), /\+ or #/);
  assert.equal(normaliseZ2mLightConfig({target: "a", friendlyName: "x"}).baseTopic, "zigbee2mqtt");
  assert.equal(normaliseZ2mLightConfig({target: "a", friendlyName: "x", group: "true"}).group, true);
  assert.deepEqual(parseZ2mTargetTopics("z2m/test/light", "z2m/test/light/set"), {baseTopic: "z2m", friendlyName: "test/light"});
  assert.equal(parseZ2mTargetTopics("home/light/state", "home/light/command"), null, "not Zigbee2MQTT's shape: set up by hand");
  assert.equal(parseZ2mTargetTopics("ceiling", "ceiling/set"), null);
});
