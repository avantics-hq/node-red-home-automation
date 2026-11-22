import * as occupancy from "./occupancy-fusion.mjs";
import * as motion from "./motion-lighting.mjs";
import * as switches from "./switch-gestures.mjs";
import * as room from "./room-lighting.mjs";
import * as source from "./source-readiness.mjs";
import * as volume from "./volume-ownership.mjs";
import * as theatre from "./theatre-activity.mjs";

const examples = [occupancy, motion, switches, room, source, volume, theatre];
const results = examples.map(({name, run}) => ({name, ...run()}));

if (process.argv.includes("--verify")) {
  console.log(`Contract examples passed (${results.length}).`);
} else {
  console.log(JSON.stringify(results, null, 2));
}
