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
// The exports map exposes only package.json, so a deep import into dist/
// fails. Node-RED reads package.json and loads each node by file path, which
// the map doesn't affect, as the rest of this smoke shows.
const deepImport = (() => {
  try {
    require.resolve(`${packageName}/dist/lib/room-controller.js`);
    return "resolved";
  } catch (error) {
    return error.code;
  }
})();

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
    errors,
    deepImport
  }, null, 2));
  const missing = expected.filter((type) => !registered.includes(type));
  if (errors.length || missing.length) failure = `missing: ${missing.join(", ") || "none"}; errors: ${errors.length}`;
  if (!failure && deepImport !== "ERR_PACKAGE_PATH_NOT_EXPORTED") failure = `a deep import into dist/ gave ${deepImport}, not ERR_PACKAGE_PATH_NOT_EXPORTED`;
  if (!failure) failure = await checkExamples();
  if (!failure) failure = await checkAnnounceOnConnect();
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
} finally {
  await RED.stop().catch(() => {});
}

// Deploys each example flow on its own tab. A node the runtime could not
// create, or an unexpected "invalid configuration" status, fails the smoke.
// Every adapter uses that one badge text for a configuration it cannot use
// (test/nodes.test.ts checks it).
// The display controller needs device hosts, and the theatre state contract an
// area (it names topics and Home Assistant entities after it); the examples
// leave both for the user to fill in.
async function checkExamples() {
  const expectedInvalid = new Set(["home-display-mode-controller", "home-theatre-state-contract"]);
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

// A publishing node announces itself again when a Status node watching MQTT
// out reports it connected (#185): Node-RED's MQTT broker node drops what it
// is given before it connects (5.0.10 nodes/core/network/10-mqtt.js publish),
// so the announcement made as the flows start is lost on a first start, a
// full deploy or a restart. Through the runtime's own Status node path, with
// no socket: the broker node never connects (autoConnect off, an .invalid
// host), and the check sets MQTT out's status as the broker node would.
async function checkAnnounceOnConnect() {
  const handed = [];
  const tab = {id: "smoke0announce0tab", type: "tab", label: "announce"};
  const flow = [
    tab,
    {id: "smoke0broker", type: "mqtt-broker", name: "", broker: "broker.invalid", port: "1883", clientid: "", autoConnect: false,
      usetls: false, protocolVersion: "4", keepalive: "60", cleansession: true},
    {id: "smoke0room", type: "home-room-lighting-controller", z: tab.id, name: "", area: "smoke", targets: "[{\"id\":\"main\"}]",
      publishState: true, discovery: true, idScheme: "node", discoveryPrefix: "homeassistant", initialTransitionSeconds: 1,
      wires: [["smoke0out", "smoke0count"], [], []]},
    {id: "smoke0out", type: "mqtt out", z: tab.id, broker: "smoke0broker", topic: "", qos: "", retain: "", wires: []},
    {id: "smoke0status", type: "status", z: tab.id, name: "", scope: ["smoke0out"], wires: [["smoke0room"]]},
    // What the room hands MQTT out, as topics.
    {id: "smoke0count", type: "function", z: tab.id, name: "", outputs: 0, wires: [],
      func: "const handed = global.get('smoke-handed') || []; handed.push(msg.topic); global.set('smoke-handed', handed); return null;"}
  ];
  const settle = () => new Promise((done) => setTimeout(done, 200));
  const take = () => {
    const context = RED.nodes.getNode("smoke0count").context().global;
    const topics = context.get("smoke-handed") || [];
    context.set("smoke-handed", []);
    return topics;
  };
  await RED.runtime.flows.setFlows({flows: {flows: flow}, deploymentType: "full"});
  await settle();
  const atStart = take();
  const out = RED.nodes.getNode("smoke0out");
  out.status({fill: "yellow", shape: "ring", text: "node-red:common.status.connecting"});
  await settle();
  const connecting = take();
  out.status({fill: "green", shape: "dot", text: "node-red:common.status.connected"});
  await settle();
  const connected = take();
  const wanted = ["home/smoke/lighting/availability", "homeassistant/sensor/nrha_smoke0room_main_control/config"];
  console.log(JSON.stringify({announceOnConnect: {atStart: atStart.length, connecting: connecting.length, connected: wanted.filter((topic) => connected.includes(topic))}}));
  if (!wanted.every((topic) => atStart.includes(topic))) return "the room didn't announce as the flows started";
  if (connecting.length) return "the room announced on MQTT out's connecting status";
  if (!wanted.every((topic) => connected.includes(topic))) return "the room didn't announce again when MQTT out reported connected";
  return null;
}

if (failure) {
  console.error(`Node-RED smoke failed: ${failure}`);
  process.exit(1);
}
console.log(`Node-RED smoke passed: ${expected.length} node types registered, example flows deployed, announced again on MQTT out's connect.`);
process.exit(0);
