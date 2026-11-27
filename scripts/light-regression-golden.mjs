// Records the golden fingerprints for the room's regression proof: the
// generated histories (test/light-regression/histories.ts) replayed through
// an earlier build's room controller and this build's Zigbee2MQTT light
// adapters (test/light-regression/replay.ts). For each history it keeps:
// - `steps`: a short fingerprint of each event's decisions (control states,
//   personAt, control sensor publications and the traces that matter) and
//   /set publications, so the test can find the first event where two rooms
//   part;
// - `withoutOwners`: fingerprints of the history with its owner intents and
//   releases taken out, of every /set publication and of the decisions,
//   with the number of publications.
// It also keeps the full publications of a few owner-free histories, to read
// when one differs.
//
// Usage: npm run build, then
//   node scripts/light-regression-golden.mjs <dist of the earlier build> <ref>
// The earlier build is 6.0.0's (ac9d11f), the room before owner stacks.
import {writeFileSync} from "node:fs";
import {resolve} from "node:path";
import {pathToFileURL} from "node:url";

const oldDist = resolve(process.argv[2] ?? "dist");
const ref = process.argv[3] ?? "ac9d11f";
const {publishRoom} = await import(pathToFileURL(resolve(oldDist, "lib/room-publishing.js")).href);
const {generateHistories, fingerprintOf, withoutOwners} = await import(pathToFileURL(resolve("dist/test/light-regression/histories.js")).href);
const {replay} = await import(pathToFileURL(resolve("dist/test/light-regression/replay.js")).href);

const histories = generateHistories(400);
const golden = {
  base: ref,
  histories: histories.map((history) => {
    const full = replay(history, {publishRoom});
    const plain = replay(withoutOwners(history), {publishRoom});
    return {
      seed: history.seed,
      steps: full.steps.map((step) => fingerprintOf(step).slice(0, 8)).join(""),
      withoutOwners: {sets: fingerprintOf(plain.sets), decisions: fingerprintOf(plain.decisions), publications: plain.sets.length}
    };
  }),
  samples: [1, 2, 3].map((seed) => ({seed, sets: replay(withoutOwners(histories[seed - 1]), {publishRoom}).sets}))
};
writeFileSync(resolve("test/fixtures/light-regression.json"), JSON.stringify(golden) + "\n");
console.log(`recorded ${golden.histories.length} histories against ${ref}`);
