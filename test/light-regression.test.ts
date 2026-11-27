"use strict";

// The light adapters' acceptance bar: every /set publication byte for byte,
// and the room's decisions, as the room sent and made them before the
// adapters (fingerprints in test/fixtures/light-regression.json, recorded
// from ac01c34 by scripts/light-regression-golden.mjs).
//
// Intended differences:
// - Left out: the room now asks each light for a reading at its startup
//   message (a /get on a light, nothing on a group), and a control state
//   carries "available" once an adapter reports availability, which these
//   histories never do.
// - In the decisions of the histories listed in INTENDED, and nowhere else,
//   each checked against the room's full decisions from before:
//   1. "duplicate echo": the same /set message seen twice, the first of which
//      the room restyles a light for. The room used to see both copies
//      itself, and matched the second against its new restyle
//      (mutated-own-command). Now the second reaches the light's adapter
//      before the room's restyle does, as Node-RED's message queue orders
//      them, and the room suppresses it (restyled-recently). Either way
//      nothing more is sent.
//   2. "retained first": a retained /set as the room's first message. The
//      adapter now drops it before the room; the room used to drop it too,
//      but created its empty state first. Its control and personAt are
//      empty either way.
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import test from "node:test";
import {fingerprintOf, generateHistories} from "./light-regression/histories";
import {replay} from "./light-regression/replay";

const golden = JSON.parse(readFileSync(resolve(__dirname, "../../test/fixtures/light-regression.json"), "utf8")) as {
  base: string;
  histories: Array<{seed: number; sets: string; decisions: string; publications: number}>;
  samples: Array<{seed: number; sets: Array<[number, string, string]>}>;
  decisions: Array<{seed: number; decisions: Array<[number, unknown, string[], string | null, string | null]>}>;
};
const histories = generateHistories(golden.histories.length);
const INTENDED: Record<number, "duplicate echo" | "retained first"> = {
  13: "duplicate echo", 21: "duplicate echo", 91: "duplicate echo", 123: "duplicate echo", 174: "duplicate echo",
  370: "duplicate echo", 394: "duplicate echo", 73: "retained first", 119: "retained first"
};

test("through the light adapters, every /set publication and decision is what the room made before them", () => {
  assert.equal(golden.base, "ac01c34");
  let publications = 0;
  const differing: number[] = [];
  for (const [index, history] of histories.entries()) {
    const expected = golden.histories[index]!;
    assert.equal(history.seed, expected.seed);
    const {sets, decisions} = replay(history);
    publications += sets.length;
    if (fingerprintOf(sets) !== expected.sets) differing.push(history.seed);
    else if (fingerprintOf(decisions) !== expected.decisions && !INTENDED[history.seed]) differing.push(history.seed);
  }
  // For a difference, compare the sample's publications to see the first one that differs.
  for (const sample of golden.samples) assert.deepEqual(replay(histories[sample.seed - 1]!).sets, sample.sets, `seed ${sample.seed}`);
  assert.deepEqual(differing, [], `histories that differ: ${differing.join(", ")}`);
  assert.equal(publications, golden.histories.reduce((sum, {publications: count}) => sum + count, 0));
});

test("where the room's decisions differ, each difference is one of the intended ones, on the event that causes it", () => {
  assert.deepEqual(golden.decisions.map(({seed}) => seed).sort((a, b) => a - b), Object.keys(INTENDED).map(Number).sort((a, b) => a - b));
  for (const {seed, decisions: before} of golden.decisions) {
    const history = histories[seed - 1]!;
    const after = replay(history).decisions as typeof before;
    assert.notEqual(fingerprintOf(after), golden.histories[seed - 1]!.decisions, `seed ${seed} differs at all`);
    for (const [index, entry] of after.entries()) {
      const old = before[index]!;
      if (JSON.stringify(entry) === JSON.stringify(old)) continue;
      const event = history.events[index]!;
      if (INTENDED[seed] === "duplicate echo") {
        assert.ok(event.type === "echo" && event.mode === "twice", `seed ${seed}: ${JSON.stringify(event)}`);
        const swapped = old[2].map((name) => name === "command-observed:ignored:mutated-own-command" ? "external-command:suppressed:restyled-recently" : name).sort();
        assert.deepEqual([entry[0], entry[1], entry[2], entry[3], entry[4]], [old[0], old[1], swapped, old[3], old[4]], `seed ${seed}`);
      } else {
        assert.ok((event.type === "set" && event.retain === true), `seed ${seed}: ${JSON.stringify(event)}`);
        assert.deepEqual([old[3], old[4], entry[3], entry[4], entry[1], entry[2]], ["{}", "{}", null, null, old[1], old[2]], `seed ${seed}`);
      }
    }
  }
});

test("the comparison can fail: one conversion off by one changes the fingerprints", () => {
  const changed = histories.slice(0, 50).filter((history, index) => fingerprintOf(replay(history, {perturb: true}).sets) !== golden.histories[index]!.sets);
  assert.ok(changed.length > 40, `${changed.length} of 50 histories noticed`);
});
