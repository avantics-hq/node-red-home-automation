"use strict";

import assert from "node:assert/strict";
import test from "node:test";
import {
  normaliseMotionConfig,
  transitionMotion,
  type LightingIntent,
  type MotionConfig,
  type MotionEffect
} from "../lib/motion-policy";

const config: MotionConfig & {area: string} = {
  area: "kitchen",
  onTargets: ["cooking", "dining"],
  offTargets: ["cooking", "dining", "cabinets"],
  defaultDelaySeconds: 30,
  defaultIlluminanceCutoff: 150
};

function sendEffects(result: ReturnType<typeof transitionMotion>): LightingIntent[] {
  return result.effects
    .filter((effect): effect is Extract<MotionEffect, {kind: "send"}> => effect.kind === "send")
    .map((effect) => effect.message);
}

test("dark enabled motion emits one ON intent", () => {
  let result = transitionMotion(undefined, {source: "illuminance", payload: 12}, config, true, 1000);
  result = transitionMotion(result.state, {source: "occupancy", payload: {occupied: true, trigger: "motion"}}, config, true, 2000);

  assert.deepEqual(sendEffects(result), [{
    lighting: {
      kind: "intent",
      targets: ["cooking", "dining"],
      state: "ON",
      source: "motion"
    }
  }]);
  assert.equal(result.traces.find((entry) => entry.event === "occupancy")?.outcome, "emit-on");
});

test("disabled and bright motion expose distinct suppression reasons", () => {
  const disabled = transitionMotion(
    undefined,
    {source: "occupancy", payload: {occupied: true, trigger: "motion"}},
    config,
    false,
    1000
  );
  assert.equal(sendEffects(disabled).length, 0);
  assert.equal(disabled.traces.find((entry) => entry.event === "occupancy")?.reason, "disabled");

  let bright = transitionMotion(undefined, {source: "illuminance", payload: 151}, config, true, 1000);
  bright = transitionMotion(bright.state, {source: "occupancy", payload: {occupied: true, trigger: "motion"}}, config, true, 2000);
  assert.equal(sendEffects(bright).length, 0);
  assert.equal(bright.traces.find((entry) => entry.event === "occupancy")?.reason, "too-bright");
});

test("only the newest vacancy timer may emit OFF", () => {
  const firstVacancy = transitionMotion(undefined, {source: "occupancy", payload: {occupied: false}}, config, true, 1000);
  const firstSchedule = firstVacancy.effects.find(
    (effect): effect is Extract<MotionEffect, {kind: "schedule-off-timer"}> =>
      effect.kind === "schedule-off-timer"
  );
  const secondVacancy = transitionMotion(firstVacancy.state, {source: "occupancy", payload: {occupied: false}}, config, true, 1001);
  const secondSchedule = secondVacancy.effects.find(
    (effect): effect is Extract<MotionEffect, {kind: "schedule-off-timer"}> =>
      effect.kind === "schedule-off-timer"
  );
  assert.ok(firstSchedule);
  assert.ok(secondSchedule);

  const stale = transitionMotion(secondVacancy.state, {
    source: "off-timer",
    generation: firstSchedule.generation
  }, config, true, 31000);
  assert.equal(sendEffects(stale).length, 0);
  assert.equal(stale.traces[0]?.reason, "stale-generation");

  const current = transitionMotion(stale.state, {
    source: "off-timer",
    generation: secondSchedule.generation
  }, config, true, 31001);
  assert.equal(sendEffects(current).length, 1);
  assert.equal(sendEffects(current)[0]?.lighting.state, "OFF");
});

test("wall switches belong to the switch policy: motion ignores them and says so", () => {
  for (const source of ["switch", "switch-startup", "switch-availability", "switch-timer"]) {
    const result = transitionMotion(undefined, {source, payload: {state: true}}, config, true, 1000);
    assert.deepEqual(result.effects, [], source);
    assert.deepEqual(result.traces.map(({outcome, reason}) => [outcome, reason]), [["ignored", "wall switches belong to the switch policy"]], source);
  }
});

test("saved wall-switch state from earlier versions loads and is ignored", () => {
  const saved = {
    areaEnabled: true, illuminance: 12, illuminanceCutoff: 150, delaySeconds: 30, offTimerGeneration: 2, offTimerDueAt: null,
    wallInput: {baselineKnown: true, value: true, generation: 4, edgeAt: 900, timerDueAt: 1400},
    switchStateKnown: true, switchState: true
  };
  const result = transitionMotion(saved as never, {source: "occupancy", payload: {occupied: true, trigger: "motion"}}, config, true, 2000);
  assert.equal(Object.hasOwn(result.state, "wallInput"), false);
  assert.equal(sendEffects(result)[0]?.lighting.state, "ON");
});

test("the vacancy OFF says when the room went vacant", () => {
  let result = transitionMotion(undefined, {source: "occupancy", payload: {occupied: false}}, config, true, 5000);
  const generation = result.state.offTimerGeneration;
  result = transitionMotion(result.state, {source: "off-timer", generation}, config, true, 35000);
  const off = sendEffects(result)[0]!;
  assert.equal(off.lighting.state, "OFF");
  assert.equal(off.lighting.vacantSince, new Date(5000).toISOString());
});

function scheduled(result: ReturnType<typeof transitionMotion>) {
  return result.effects.find(
    (effect): effect is Extract<MotionEffect, {kind: "schedule-off-timer"}> => effect.kind === "schedule-off-timer"
  );
}

test("a vacancy while motion is disabled schedules no off-timer", () => {
  let area = transitionMotion(undefined, {source: "area-enabled", payload: "off"}, config, true, 1000);
  area = transitionMotion(area.state, {source: "occupancy", payload: {occupied: false}}, config, true, 2000);
  assert.equal(scheduled(area), undefined);
  assert.equal(area.state.offTimerDueAt, null);
  const suppressed = area.traces.find((entry) => entry.event === "occupancy");
  assert.equal(suppressed?.outcome, "suppressed");
  assert.equal(suppressed?.reason, "disabled");

  const global = transitionMotion(undefined, {source: "occupancy", payload: {occupied: false}}, config, false, 2000);
  assert.equal(scheduled(global), undefined);
  assert.equal(global.traces.find((entry) => entry.event === "occupancy")?.reason, "disabled");
});

test("an off-timer that fires after motion is disabled globally emits nothing", () => {
  // Two nodes share the global switch; only node A receives global-enabled.
  const nodeB = transitionMotion(undefined, {source: "occupancy", payload: {occupied: false}}, config, true, 1000);
  const timer = scheduled(nodeB);
  assert.ok(timer);
  const nodeA = transitionMotion(undefined, {source: "global-enabled", payload: "off"}, config, true, 2000);
  assert.equal(nodeA.globalEnabled, false);

  const fired = transitionMotion(nodeB.state, {source: "off-timer", generation: timer.generation}, config, nodeA.globalEnabled, 31_000);
  assert.equal(sendEffects(fired).length, 0);
  assert.equal(fired.state.offTimerDueAt, null);
  const suppressed = fired.traces.find((entry) => entry.event === "off-timer");
  assert.equal(suppressed?.outcome, "suppressed");
  assert.equal(suppressed?.reason, "disabled");
});

test("ON in any case enables motion; other values disable it", () => {
  for (const payload of ["ON", "On", "on", true]) {
    const result = transitionMotion(undefined, {source: "area-enabled", payload}, config, true, 1000);
    assert.equal(result.status.enabled, true, String(payload));
    assert.equal(transitionMotion(undefined, {source: "global-enabled", payload}, config, false, 1000).globalEnabled, true);
  }
  for (const payload of ["OFF", "off", false, "true", 1]) {
    assert.equal(transitionMotion(undefined, {source: "area-enabled", payload}, config, true, 1000).status.enabled, false);
  }
});

test("re-enabling motion switches nothing off; a later vacancy schedules OFF as before", () => {
  let result = transitionMotion(undefined, {source: "area-enabled", payload: "off"}, config, true, 1000);
  result = transitionMotion(result.state, {source: "occupancy", payload: {occupied: false}}, config, true, 2000);
  result = transitionMotion(result.state, {source: "area-enabled", payload: "ON"}, config, true, 3000);
  assert.equal(sendEffects(result).length, 0);
  assert.equal(scheduled(result), undefined);

  result = transitionMotion(result.state, {source: "occupancy", payload: {occupied: false}}, config, true, 4000);
  const timer = scheduled(result);
  assert.equal(timer?.delayMs, 30_000);
  result = transitionMotion(result.state, {source: "off-timer", generation: timer?.generation}, config, true, 34_000);
  assert.deepEqual(sendEffects(result).map((message) => message.lighting.state), ["OFF"]);
});

test("motion settings are read once, from the node's editor values", () => {
  assert.deepEqual(normaliseMotionConfig({}), {onTargets: ["main"], offTargets: ["main"], defaultDelaySeconds: 120, defaultIlluminanceCutoff: 10});
  const read = normaliseMotionConfig({onTargets: "[\"ceiling\",\"lamp\"]", defaultDelaySeconds: "300", defaultIlluminanceCutoff: "0"});
  assert.deepEqual(read, {onTargets: ["ceiling", "lamp"], offTargets: ["ceiling", "lamp"], defaultDelaySeconds: 300, defaultIlluminanceCutoff: 0});
  assert.throws(() => normaliseMotionConfig({onTargets: "[1]"}), /on targets must be a JSON array of strings/);
  assert.throws(() => normaliseMotionConfig({offTargets: ""}), /off targets must be valid JSON/);
  assert.throws(() => normaliseMotionConfig({defaultDelaySeconds: ""}), /vacancy delay must be a number/);
  assert.throws(() => normaliseMotionConfig({defaultIlluminanceCutoff: "dark"}), /illuminance cutoff must be a number/);
});

test("a redeploy with a changed delay or cutoff uses the new setting", () => {
  // The node ran with the old settings; then the user changes both and redeploys.
  const ran = transitionMotion(undefined, {source: "illuminance", payload: 5}, config, true, 1000).state;
  assert.equal(ran.delaySeconds, 30);
  const changed = {...config, defaultDelaySeconds: 90, defaultIlluminanceCutoff: 40};
  const redeployed = transitionMotion(ran, {source: "illuminance", payload: 5}, changed, true, 2000).state;
  assert.equal(redeployed.delaySeconds, 90);
  assert.equal(redeployed.illuminanceCutoff, 40);
  // State saved before the setting was recorded also takes the setting.
  const legacy = {...ran, delaySeconds: 600, illuminanceCutoff: 999, delaySecondsSetting: undefined, illuminanceCutoffSetting: undefined};
  assert.equal(transitionMotion(legacy as never, {source: "illuminance", payload: 5}, config, true, 3000).state.delaySeconds, 30);
});

test("a delay or cutoff message overrides the setting until it changes", () => {
  let state = transitionMotion(undefined, {source: "delay", payload: 45}, config, true, 1000).state;
  state = transitionMotion(state, {source: "illuminance-cut-off", payload: 80}, config, true, 1100).state;
  assert.equal(state.delaySeconds, 45, "the delay message is in seconds");
  assert.equal(state.illuminanceCutoff, 80);
  // A redeploy with the same settings keeps the overrides.
  state = transitionMotion(state, {source: "illuminance", payload: 5}, config, true, 2000).state;
  assert.deepEqual([state.delaySeconds, state.illuminanceCutoff], [45, 80]);
  // A redeploy with a changed delay setting replaces only the delay override.
  state = transitionMotion(state, {source: "illuminance", payload: 5}, {...config, defaultDelaySeconds: 60}, true, 3000).state;
  assert.deepEqual([state.delaySeconds, state.illuminanceCutoff], [60, 80]);
  // The vacancy timer uses the delay in seconds.
  const vacancy = transitionMotion(state, {source: "occupancy", payload: {occupied: false}}, {...config, defaultDelaySeconds: 60}, true, 4000);
  assert.deepEqual(vacancy.effects.find((effect) => effect.kind === "schedule-off-timer"), {kind: "schedule-off-timer", delayMs: 60000, generation: vacancy.state.offTimerGeneration});
});

test("a start with nothing saved counts as vacancy from then, so lights left on go off", () => {
  const started = transitionMotion(undefined, {source: "cold-start"}, config, true, 1000);
  assert.deepEqual(started.effects.filter(({kind}) => kind === "schedule-off-timer"),
    [{kind: "schedule-off-timer", delayMs: 30000, generation: 1}]);
  assert.deepEqual(sendEffects(started), [], "nothing is sent at the start");
  assert.equal(started.traces.at(-1)?.reason, "no-saved-state");
  const due = transitionMotion(started.state, {source: "off-timer", generation: 1}, config, true, 31000);
  assert.deepEqual(sendEffects(due).map(({lighting}) => [lighting.state, lighting.targets, lighting.vacantSince]),
    [["OFF", config.offTargets, new Date(1000).toISOString()]]);

  // Occupancy reported first cancels it, as after any vacancy.
  const occupied = transitionMotion(started.state, {source: "occupancy", payload: {occupied: true, trigger: "motion"}}, config, true, 2000);
  assert.deepEqual(sendEffects(transitionMotion(occupied.state, {source: "off-timer", generation: 1}, config, true, 31000)), []);

  const disabled = transitionMotion({areaEnabled: false}, {source: "cold-start"}, config, true, 1000);
  assert.deepEqual(disabled.effects, []);
  assert.equal(transitionMotion(undefined, {source: "cold-start"}, config, false, 1000).effects.length, 0, "globally disabled");
});

test("a pause holds motion lighting for its owner, apart from the user's enable", () => {
  const run = (state: Parameters<typeof transitionMotion>[0], input: Parameters<typeof transitionMotion>[1], at: number) =>
    transitionMotion(state, input, config, true, at);
  let result = run(undefined, {source: "illuminance", payload: 10}, 1000);
  result = run(result.state, {source: "pause", payload: true, owner: "blind"}, 2000);
  assert.deepEqual(result.state.pausedBy, ["blind"]);
  assert.equal(result.state.areaEnabled, true, "the user's enable is untouched");
  assert.deepEqual([result.status.enabled, result.status.paused], [false, true]);
  assert.deepEqual(sendEffects(run(result.state, {source: "occupancy", payload: {occupied: true}}, 3000)), [], "no intent while paused");

  // Two owners: motion resumes only when both have released.
  result = run(result.state, {source: "pause", payload: "ON", owner: "curtain"}, 4000);
  result = run(result.state, {source: "pause", payload: false, owner: "blind"}, 5000);
  assert.deepEqual([result.state.pausedBy, result.status.enabled], [["curtain"], false]);
  result = run(result.state, {source: "pause", payload: false, owner: "curtain"}, 6000);
  assert.deepEqual([result.state.pausedBy, result.status.enabled], [[], true]);
  assert.equal(sendEffects(run(result.state, {source: "occupancy", payload: {occupied: true}}, 7000))[0]?.lighting.state, "ON");
});

test("a pause cancels a pending vacancy timer, as switching motion off does", () => {
  let result = transitionMotion(undefined, {source: "illuminance", payload: 10}, config, true, 1000);
  result = transitionMotion(result.state, {source: "occupancy", payload: {occupied: true}}, config, true, 2000);
  result = transitionMotion(result.state, {source: "occupancy", payload: {occupied: false}}, config, true, 3000);
  assert.ok(result.state.offTimerDueAt !== null);
  result = transitionMotion(result.state, {source: "pause", payload: true, owner: "blind"}, config, true, 4000);
  assert.equal(result.state.offTimerDueAt, null);
  assert.ok(result.effects.some((effect) => effect.kind === "cancel-off-timer"));
});
