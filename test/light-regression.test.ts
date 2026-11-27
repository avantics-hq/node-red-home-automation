"use strict";

// The room's regression proof since owner stacks (6.1): the generated
// histories replayed through the room and its Zigbee2MQTT light adapters,
// against 6.0.0's room (fingerprints in test/fixtures/light-regression.json,
// recorded from ac9d11f by scripts/light-regression-golden.mjs). 6.0.0's own
// proof, that the adapters changed nothing from the room before them, is the
// same file at that commit.
//
// - Without owners (no owner intents, no releases), every /set publication
//   and decision is 6.0.0's, byte for byte.
// - With them, a history may part from 6.0.0 only at an owner intent or a
//   release: owners now hold lights off, stack, and on the last release give
//   a light back what it was (room-controller.test.ts tests each rule). From
//   there on its decisions follow from a different state, so only the first
//   difference is checked.
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import test from "node:test";
import {fingerprintOf, generateHistories, isOwnerEvent, withoutOwners} from "./light-regression/histories";
import {replay} from "./light-regression/replay";

const golden = JSON.parse(readFileSync(resolve(__dirname, "../../test/fixtures/light-regression.json"), "utf8")) as {
  base: string;
  histories: Array<{seed: number; steps: string; withoutOwners: {sets: string; decisions: string; publications: number}}>;
  samples: Array<{seed: number; sets: Array<[number, string, string]>}>;
};
const histories = generateHistories(golden.histories.length);

test("without owners, every /set publication and decision is 6.0.0's", () => {
  assert.equal(golden.base, "ac9d11f");
  let publications = 0;
  const differing: number[] = [];
  for (const [index, history] of histories.entries()) {
    const expected = golden.histories[index]!;
    assert.equal(history.seed, expected.seed);
    const {sets, decisions} = replay(withoutOwners(history));
    publications += sets.length;
    if (fingerprintOf(sets) !== expected.withoutOwners.sets || fingerprintOf(decisions) !== expected.withoutOwners.decisions) differing.push(history.seed);
  }
  // For a difference, compare the sample's publications to see the first one that differs.
  for (const sample of golden.samples) assert.deepEqual(replay(withoutOwners(histories[sample.seed - 1]!)).sets, sample.sets, `seed ${sample.seed}`);
  assert.deepEqual(differing, [], `histories that differ: ${differing.join(", ")}`);
  assert.equal(publications, golden.histories.reduce((sum, {withoutOwners: {publications: count}}) => sum + count, 0));
});

test("with owners, a history parts from 6.0.0 only at an owner intent or a release", () => {
  let parted = 0;
  for (const [index, history] of histories.entries()) {
    const expected = golden.histories[index]!.steps;
    const steps = replay(history).steps.map((step) => fingerprintOf(step).slice(0, 8));
    assert.equal(steps.length * 8, expected.length, `seed ${history.seed}`);
    const first = steps.findIndex((step, at) => step !== expected.slice(at * 8, at * 8 + 8));
    if (first < 0) continue;
    parted += 1;
    assert.ok(isOwnerEvent(history.events[first]!), `seed ${history.seed}, event ${first}: ${JSON.stringify(history.events[first])}`);
  }
  // Most histories have an owner switch a light off, or release one that was off.
  assert.ok(parted > 200, `${parted} histories parted`);
});

test("the comparison can fail: one conversion off by one changes the fingerprints", () => {
  const changed = histories.slice(0, 50).filter((history, index) => fingerprintOf(replay(withoutOwners(history), {perturb: true}).sets) !== golden.histories[index]!.withoutOwners.sets);
  assert.ok(changed.length > 40, `${changed.length} of 50 histories noticed`);
});
