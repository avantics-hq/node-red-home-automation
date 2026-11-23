// Loads the packed package in an embedded Node-RED runtime and checks that
// every node type in package.json registered, then deploys each packaged
// example flow and checks that every node in it is created. No HTTP server is
// started.
//
// Usage: node scripts/node-red-smoke.mjs <dir>
// <dir> holds node-red and the packed package in node_modules and is used as
// the Node-RED userDir.
import {createRequire} from "node:module";
import {readdirSync, readFileSync} from "node:fs";
import {dirname, join, resolve} from "node:path";

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
  if (!failure) failure = await checkExamples();
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
} finally {
  await RED.stop().catch(() => {});
}

// Deploys each example flow on its own tab. A node the runtime could not
// create, or an unexpected "invalid configuration" status, fails the smoke.
// Every adapter uses that one badge text for a configuration it cannot use
// (test/nodes.test.ts checks it).
// The display controller needs device hosts, which the examples leave blank.
async function checkExamples() {
  const expectedInvalid = new Set(["home-display-mode-controller"]);
  const examplesDir = join(dirname(require.resolve(`${packageName}/package.json`)), "examples");
  const statuses = new Map();
  RED.events.on("node-status", (event) => statuses.set(event.id, event.status));
  const problems = [];
  for (const file of readdirSync(examplesDir).filter((name) => name.endsWith(".json")).sort()) {
    const flow = JSON.parse(readFileSync(join(examplesDir, file), "utf8"));
    const tab = {id: "smoke0example0tab", type: "tab", label: file};
    statuses.clear();
    await RED.runtime.flows.setFlows({flows: {flows: [tab, ...flow.map((node) => ({...node, z: tab.id}))]}, deploymentType: "full"});
    await new Promise((done) => setTimeout(done, 200));
    const notCreated = flow.filter((node) => !RED.nodes.getNode(node.id)).map((node) => node.type);
    const invalid = flow.filter((node) => statuses.get(node.id)?.text === "invalid configuration").map((node) => node.type);
    console.log(JSON.stringify({example: file, nodes: flow.length, notCreated, invalidConfiguration: invalid}));
    if (notCreated.length) problems.push(`${file}: not created: ${notCreated.join(", ")}`);
    const unexpected = invalid.filter((type) => !expectedInvalid.has(type));
    if (unexpected.length) problems.push(`${file}: invalid configuration: ${unexpected.join(", ")}`);
  }
  return problems.length ? problems.join("; ") : null;
}

if (failure) {
  console.error(`Node-RED smoke failed: ${failure}`);
  process.exit(1);
}
console.log(`Node-RED smoke passed: ${expected.length} node types registered, example flows deployed.`);
process.exit(0);
