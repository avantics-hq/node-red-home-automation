// Loads the packed package in an embedded Node-RED runtime and checks that
// every node type in package.json registered. No HTTP server is started.
//
// Usage: node scripts/node-red-smoke.mjs <dir>
// <dir> holds node-red and the packed package in node_modules and is used as
// the Node-RED userDir.
import {createRequire} from "node:module";
import {readFileSync} from "node:fs";
import {resolve} from "node:path";

const userDir = resolve(process.argv[2] || "");
if (!process.argv[2]) throw new Error("usage: node scripts/node-red-smoke.mjs <dir>");

const require = createRequire(resolve(userDir, "package.json"));
const RED = require("node-red");
const packageName = "@avantics/node-red-home-automation";
const manifest = JSON.parse(readFileSync(require.resolve(`${packageName}/package.json`), "utf8"));
const expected = Object.keys(manifest["node-red"].nodes).sort();

RED.init(undefined, {
  userDir,
  flowFile: "smoke-flows.json",
  httpAdminRoot: false,
  httpNodeRoot: false,
  disableEditor: true,
  credentialSecret: "smoke-test-only",
  logging: {console: {level: "warn"}}
});

let failure = null;
try {
  await RED.start();
  const module = RED.runtime.nodes.getModuleInfo
    ? await RED.runtime.nodes.getModuleInfo({module: packageName})
    : null;
  const sets = module ? Object.values(module.nodes) : [];
  const errors = sets.filter((set) => set.err).map((set) => `${set.name}: ${set.err}`);
  // A type counts only when its set is enabled without error and the runtime
  // has a constructor for it.
  const registered = sets
    .filter((set) => set.enabled && !set.err)
    .flatMap((set) => set.types)
    .filter((type) => typeof RED.nodes.getType(type) === "function")
    .sort();
  console.log(JSON.stringify({
    nodeRed: RED.version(),
    node: process.version,
    module: module ? `${module.name}@${module.version}` : null,
    registered: registered.length,
    expected: expected.length,
    errors
  }, null, 2));
  const missing = expected.filter((type) => !registered.includes(type));
  if (errors.length || missing.length) failure = `missing: ${missing.join(", ") || "none"}; errors: ${errors.length}`;
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
} finally {
  await RED.stop().catch(() => {});
}

if (failure) {
  console.error(`Node-RED smoke failed: ${failure}`);
  process.exit(1);
}
console.log(`Node-RED smoke passed: ${expected.length} node types registered.`);
process.exit(0);
