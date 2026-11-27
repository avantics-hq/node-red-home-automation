// Records the golden fingerprints for the light-adapter regression proof:
// the generated histories (test/light-regression/histories.ts) driven
// through the room controller as it was before the light adapters, with
// Zigbee2MQTT targets, in the input shapes it took then. For each history it
// keeps a fingerprint of every /set publication (time, topic, payload bytes)
// and of the room's decisions (control states, personAt, control sensor
// publications and the traces that matter), and the full publications of a
// few histories to read when one differs.
//
// Usage: npm run build, then
//   node scripts/light-regression-golden.mjs <dist of the earlier build> [<ref>]
// The earlier build is ac01c34's (the room before the adapters).
import {writeFileSync} from "node:fs";
import {resolve} from "node:path";
import {pathToFileURL} from "node:url";

const oldDist = resolve(process.argv[2] ?? "dist");
const ref = process.argv[3] ?? "ac01c34";
const {publishRoom} = await import(pathToFileURL(resolve(oldDist, "lib/room-publishing.js")).href);
const {START, generateHistories, fingerprintOf} = await import(pathToFileURL(resolve("dist/test/light-regression/histories.js")).href);

const TRACES = new Set(["mutated-own-command", "restyled-recently", "already-at-level", "not-told-since-start", "person-set-after-vacancy", "held-by",
  "on-off-only", "own-command", "stale-report", "external-off", "external-values", "observed-off", "taken-back"]);

function run(history) {
  const config = {
    area: "test", displayName: "Test", initialTransitionSeconds: 1, publishState: true, discovery: false,
    targets: history.lights.map((light) => ({id: light.id, stateTopic: `z2m/${light.name}`, commandTopic: `z2m/${light.name}/set`,
      ...(light.onOffOnly ? {onOffOnly: true} : {})}))
  };
  const byId = Object.fromEntries(config.targets.map((target) => [target.id, target]));
  let state;
  const lastSet = {};
  const sets = [];
  const decisions = [];
  for (const event of history.events) {
    const now = START + event.at * 1000;
    const messages = [];
    if (event.type === "style") {
      messages.push({lighting: {kind: "style", source: "circadian", values: event.values, transitionSeconds: event.transitionSeconds,
        until: new Date(START + event.untilSeconds * 1000).toISOString(), ...(event.takeBack ? {takeBack: true} : {})}});
    } else if (event.type === "intent") {
      messages.push({lighting: event.lighting});
    } else if (event.type === "release") {
      messages.push({lighting: {kind: "release", source: "activity", ...(event.owner ? {owner: event.owner} : {}), ...(event.targets ? {targets: event.targets} : {})}});
    } else if (event.type === "report") {
      messages.push({topic: byId[event.target].stateTopic, payload: event.payload, lighting: {kind: "observed"}});
    } else if (event.type === "obey") {
      const last = lastSet[event.target];
      if (last) {
        const payload = {state: last.state};
        if (last.brightness !== undefined) payload.brightness = last.brightness;
        if (last.color_temp !== undefined) payload.color_temp = last.color_temp;
        messages.push({topic: byId[event.target].stateTopic, payload, lighting: {kind: "observed"}});
      }
    } else if (event.type === "set") {
      messages.push({topic: byId[event.target].commandTopic, payload: event.payload, ...(event.retain ? {retain: true} : {}), lighting: {kind: "command-observed"}});
    } else if (event.type === "echo") {
      const last = lastSet[event.target];
      if (last) {
        const payload = event.mode === "bare" ? {state: last.state} : last;
        for (let copy = 0; copy < (event.mode === "twice" ? 2 : 1); copy += 1) {
          messages.push({topic: byId[event.target].commandTopic, payload, lighting: {kind: "command-observed"}});
        }
      }
    } else if (event.type === "startup") {
      messages.push({lighting: {kind: "startup"}});
    } else if (event.type === "restart") {
      if (!event.keep) state = undefined;
    }
    const traces = [];
    const control = [];
    for (const msg of messages) {
      const result = publishRoom(state, msg, config, now);
      state = result.state;
      for (const output of result.outputs) {
        if (output.lighting_command) {
          sets.push([event.at, output.topic, JSON.stringify(output.payload)]);
          lastSet[output.lighting_command.target] = output.payload;
        } else if (/\/control$/.test(output.topic)) {
          control.push([output.topic, JSON.stringify(output.payload)]);
        }
      }
      for (const entry of result.traces) if (TRACES.has(entry.reason)) traces.push(`${entry.event}:${entry.outcome}:${entry.reason}`);
    }
    decisions.push([event.at, control, traces.sort(), state ? JSON.stringify(state.control) : null, state ? JSON.stringify(state.personAt) : null]);
  }
  return {sets, decisions};
}

const histories = generateHistories();
const results = histories.map((history) => ({seed: history.seed, ...run(history)}));
const golden = {
  base: ref,
  note: "Fingerprints of every /set publication and of the room's decisions, per generated history, from the room before the light adapters. Made by scripts/light-regression-golden.mjs.",
  histories: results.map(({seed, sets, decisions}) => ({seed, sets: fingerprintOf(sets), decisions: fingerprintOf(decisions), publications: sets.length})),
  samples: results.slice(0, 3).map(({seed, sets}) => ({seed, sets}))
};
writeFileSync(resolve("test/fixtures/light-regression.json"), JSON.stringify(golden, null, 1) + "\n");
console.log(`${results.length} histories, ${results.reduce((sum, {sets}) => sum + sets.length, 0)} /set publications recorded against ${ref}.`);
