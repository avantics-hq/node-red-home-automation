"use strict";

import assert from "node:assert/strict";
import test from "node:test";
import type {LightCommandMessage, LightRoomMessage} from "../lib/light-contract";
import {transitionRoom, type RoomConfig, type RoomState} from "../lib/room-controller";
import {RENEW_MS, normaliseSceneConfig, sceneTickAt, transitionScene, type SceneConfig, type SceneState} from "../lib/scene";
import {sceneDiscovery, sceneInbound, sceneStateOutputs} from "../lib/scene-publishing";

const at = (seconds: number) => Date.parse("2026-11-27T20:00:00Z") + seconds * 1000;
const exercise = normaliseSceneConfig({owner: "scene:Exercise", safetyHours: 4,
  lights: JSON.stringify([{target: "main", state: "OFF"}, {target: "tv", state: "ON"}])});
const bath = normaliseSceneConfig({owner: "scene:Bath", safetyHours: 0,
  lights: JSON.stringify([{target: "main", state: "ON", brightnessPct: 30, colorTempKelvin: 2700}])});

function run(config: SceneConfig, state: Partial<SceneState> | undefined, scene: Record<string, unknown>, seconds: number) {
  return transitionScene(state, {scene}, config, at(seconds));
}

test("settings: lights as a JSON array of a target, ON or OFF, and values for an ON light; the safety timer in hours", () => {
  assert.deepEqual(exercise.lights, [{target: "main", state: "OFF"}, {target: "tv", state: "ON"}]);
  assert.equal(exercise.safetyMs, 4 * 3_600_000);
  assert.equal(normaliseSceneConfig({owner: "o"}).safetyMs, 4 * 3_600_000, "4 hours by default");
  assert.deepEqual(normaliseSceneConfig({owner: "o"}).lights, [], "a scene may only pause motion");
  for (const [lights, message] of [
    ["{}", /lights must be a JSON array/],
    ["[{\"state\":\"ON\"}]", /light 1 needs a target/],
    ["[{\"target\":\"a\",\"state\":\"DIM\"}]", /state must be ON or OFF/],
    ["[{\"target\":\"a\",\"state\":\"ON\"},{\"target\":\"a\",\"state\":\"OFF\"}]", /listed twice/],
    ["[{\"target\":\"a\",\"state\":\"OFF\",\"brightnessPct\":5}]", /an OFF light takes no brightnessPct/],
    ["[{\"target\":\"a\",\"state\":\"ON\",\"brightnessPct\":101}]", /0-100/],
    ["[{\"target\":\"a\",\"state\":\"ON\",\"colorTempKelvin\":0}]", /above 0/],
    ["[{\"target\":\"a\",\"state\":\"ON\",\"brightness\":5}]", /unknown field brightness/],
    ["not json", /lights must be valid JSON/]
  ] as const) assert.throws(() => normaliseSceneConfig({owner: "o", lights}), message, lights);
  assert.throws(() => normaliseSceneConfig({owner: "o", safetyHours: -1}), /0 \(off\) or more/);
  assert.equal(normaliseSceneConfig({owner: "o", safetyHours: "0"}).safetyMs, 0);
});

test("starting holds each light for the scene and pauses motion; ending releases them and the pause", () => {
  const started = run(exercise, undefined, {kind: "start"}, 0);
  assert.deepEqual(started.lighting, [
    {lighting: {kind: "intent", targets: ["main"], state: "OFF", owner: "scene:Exercise", source: "scene"}},
    {lighting: {kind: "intent", targets: ["tv"], state: "ON", owner: "scene:Exercise", source: "scene"}}
  ]);
  assert.deepEqual(started.motion, [{source: "pause", payload: true, owner: "scene:Exercise"}]);
  assert.deepEqual(started.status, {fill: "green", shape: "dot", text: "on · 4h 0m left"});

  const ended = run(exercise, started.state, {kind: "end", by: "trainer off"}, 600);
  assert.deepEqual(ended.lighting, [{lighting: {kind: "release", owner: "scene:Exercise", targets: ["main", "tv"], source: "scene"}}]);
  assert.deepEqual(ended.motion, [{source: "pause", payload: false, owner: "scene:Exercise"}]);
  assert.deepEqual(ended.status, {fill: "grey", shape: "dot", text: "off · ended by trainer off"});
  assert.deepEqual(run(exercise, ended.state, {kind: "end"}, 601).traces.map(({reason}) => reason), ["not-active"], "already off");

  // Values go on the intent; a plain end is by request.
  const bathOn = run(bath, undefined, {kind: "start"}, 0);
  assert.deepEqual(bathOn.lighting[0]!.lighting.values, {brightnessPct: 30, colorTempKelvin: 2700});
  assert.equal(bathOn.status.text, "on", "no timer: no time left shown");
  assert.equal(run(bath, bathOn.state, {kind: "end"}, 5).status.text, "off · ended by request");
});

test("on again renews its timer and pause and leaves its lights as they are", () => {
  const started = run(exercise, undefined, {kind: "start"}, 0);
  const again = run(exercise, started.state, {kind: "start"}, 3600);
  assert.deepEqual(again.lighting, [], "a person's change during the scene stands");
  assert.deepEqual(again.motion, [{source: "pause", payload: true, owner: "scene:Exercise"}]);
  assert.equal(again.state.endsAt, at(3600) + 4 * 3_600_000);
});

test("its ticks renew the motion pause, and end it when the safety timer runs out", () => {
  const started = run(exercise, undefined, {kind: "start"}, 0);
  assert.equal(sceneTickAt(started.state, at(0)), at(0) + RENEW_MS);
  const tick = run(exercise, started.state, {kind: "tick"}, 60);
  assert.deepEqual(tick.motion, [{source: "pause", payload: true, owner: "scene:Exercise"}]);
  assert.deepEqual(tick.lighting, []);
  assert.equal(tick.status.text, "on · 3h 59m left");
  assert.equal(sceneTickAt(tick.state, at(4 * 3600 - 30)), at(4 * 3600), "the timer's end, when sooner");
  const done = run(exercise, tick.state, {kind: "tick"}, 4 * 3600);
  assert.equal(done.status.text, "off · ended by timer");
  assert.equal(done.lighting[0]!.lighting.kind, "release");
  assert.equal(sceneTickAt(done.state, at(4 * 3600)), null);
});

test("after a restart it stays on with its timer, or ends at once if its time ran out meanwhile", () => {
  const started = run(exercise, undefined, {kind: "start"}, 0);
  const saved = JSON.parse(JSON.stringify(started.state)) as SceneState;
  const back = run(exercise, saved, {kind: "startup"}, 600);
  assert.deepEqual([back.state.active, back.lighting, back.motion.map(({payload}) => payload)], [true, [], [true]], "its lights aren't asked again");
  assert.equal(back.state.endsAt, started.state.endsAt);
  const late = run(exercise, saved, {kind: "startup"}, 5 * 3600);
  assert.equal(late.status.text, "off · ended by timer");
  // It releases what it took, even if its settings changed since.
  const changed = normaliseSceneConfig({owner: "scene:Exercise", lights: "[{\"target\":\"lamp\",\"state\":\"ON\"}]"});
  assert.deepEqual(run(changed, saved, {kind: "end"}, 700).lighting[0]!.lighting.targets, ["main", "tv"]);
  // Off, a startup does nothing.
  assert.deepEqual(run(exercise, undefined, {kind: "startup"}, 0).motion, []);
});

test("Home Assistant: a switch per scene, its state, and ON or OFF on its set topic", () => {
  const publishing = {area: "lounge", name: "Exercise mode", publishState: true, discovery: true, discoveryPrefix: "homeassistant", nodeId: "s1", idScheme: "node" as const};
  const [entry] = sceneDiscovery(publishing);
  const config = JSON.parse(entry!.payload) as Record<string, unknown>;
  assert.equal(entry!.topic, "homeassistant/switch/nrha_s1_scene_exercise_mode/config");
  assert.deepEqual([config.command_topic, config.state_topic, config.availability_topic],
    ["home/lounge/scene/exercise_mode/set", "home/lounge/scene/exercise_mode/state", "home/lounge/scene/exercise_mode/availability"]);
  assert.deepEqual(sceneStateOutputs(publishing, true), [{topic: "home/lounge/scene/exercise_mode/state", payload: "ON", retain: true}]);
  assert.deepEqual(sceneStateOutputs({...publishing, publishState: false}, true), []);
  const set = (payload: unknown, retain = false) => sceneInbound({topic: "home/lounge/scene/exercise_mode/set", payload, retain}, publishing);
  assert.equal(set("ON")?.kind, "start");
  assert.equal(set("off")?.kind, "end");
  assert.deepEqual(set("ON", true)?.traces.map(({reason}) => reason), ["retained-message"]);
  assert.deepEqual(set("maybe")?.traces.map(({reason}) => reason), ["not-on-or-off"]);
  assert.equal(sceneInbound({topic: "elsewhere", payload: "ON"}, publishing), null);
});

// A room with main and tv, styled at 60% 3000K, motion having switched main
// on, and its commands answered at once (the light shows what it was sent).
const roomConfig: RoomConfig = {area: "", displayName: "", initialTransitionSeconds: 1, targets: [{id: "main"}, {id: "tv", onOffOnly: true}]};
function room() {
  let state: RoomState | undefined;
  const commands: Array<[string, string, number | undefined]> = [];
  function send(msg: object, seconds: number) {
    const result = transitionRoom(state, msg as Parameters<typeof transitionRoom>[1], roomConfig, at(seconds));
    state = result.state;
    for (const command of result.commands as LightRoomMessage[]) {
      if (command.kind !== "command") continue;
      const {target, state: power, brightnessPct} = command as LightCommandMessage;
      commands.push([target, power, brightnessPct]);
      const reading = {kind: "observed", target, on: power === "ON", ...(brightnessPct !== undefined ? {brightnessPct} : {}),
        fields: ["brightness"], showsLast: true, observedAt: new Date(at(seconds)).toISOString()};
      state = transitionRoom(state, {light: reading}, roomConfig, at(seconds)).state;
    }
  }
  send({lighting: {kind: "style", source: "circadian", values: {brightnessPct: 60, colorTempKelvin: 3000}, transitionSeconds: 30,
    until: new Date(at(86_400)).toISOString()}}, 0);
  send({lighting: {kind: "intent", targets: ["main"], state: "ON", source: "motion"}}, 0);
  commands.length = 0;
  return {send, commands, state: () => state!};
}

for (const order of [["bath", "exercise"], ["exercise", "bath"]] as const) {
  test(`two scenes overlapping through the room: exercise, then bath on top, ended ${order[0]} first`, () => {
    const lounge = room();
    let exerciseState = run(exercise, undefined, {kind: "start"}, 10);
    for (const msg of exerciseState.lighting) lounge.send(msg, 10);
    let bathState = run(bath, undefined, {kind: "start"}, 20);
    for (const msg of bathState.lighting) lounge.send(msg, 20);
    assert.deepEqual(lounge.commands, [["main", "OFF", undefined], ["tv", "ON", undefined], ["main", "ON", 30]]);
    assert.deepEqual(lounge.state().control.main, {state: "overridden", owner: "scene:Bath"});
    lounge.commands.length = 0;

    for (const [index, which] of order.entries()) {
      const seconds = 30 + index * 10;
      if (which === "bath") {
        bathState = run(bath, bathState.state, {kind: "end"}, seconds);
        for (const msg of bathState.lighting) lounge.send(msg, seconds);
      } else {
        exerciseState = run(exercise, exerciseState.state, {kind: "end"}, seconds);
        for (const msg of exerciseState.lighting) lounge.send(msg, seconds);
      }
    }
    if (order[0] === "bath") {
      // Bath ends: main goes back to exercise's OFF; then exercise ends: main
      // back on in the room's style, tv back off.
      assert.deepEqual(lounge.commands, [["main", "OFF", undefined], ["main", "ON", 60], ["tv", "OFF", undefined]]);
    } else {
      // Exercise ends beneath bath: main stays bath's, tv goes back off; then
      // bath ends: main back in the room's style.
      assert.deepEqual(lounge.commands, [["tv", "OFF", undefined], ["main", "ON", 60]]);
    }
    assert.deepEqual(lounge.state().control, {});
    assert.deepEqual([lounge.state().desired.main, lounge.state().desired.tv], [true, false]);
  });
}
