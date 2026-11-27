// Checks, against a real Node-RED and a real MQTT broker, that a publishing
// node's announcements reach the broker when the flows start: on a first
// start, and on a full deploy, when Node-RED's MQTT broker node connects
// again. Node-RED's broker node drops anything it is given to publish while
// it isn't connected, and it connects after the flows have started, so what a
// node sends then is lost (#185). With a Status node watching the MQTT out
// node wired into the node, the node announces again once MQTT out reports
// it has connected.
//
// Each run deploys a room lighting controller (publishing and discovery on)
// wired to an MQTT out node, and listens at the broker for the room's
// availability and discovery. The runs:
// - without the Status node: they must not arrive (the check can fail);
// - with it: they must, on the first start and on a full redeploy.
//
// Usage: node scripts/node-red-mqtt-announce.mjs <dir>
// <dir> holds node-red, aedes (an MQTT broker run in this process) and the
// packed package in node_modules, as for scripts/node-red-smoke.mjs, and is
// used as the Node-RED userDir.
import {createRequire} from "node:module";
import {createServer} from "node:net";
import {rmSync} from "node:fs";
import {resolve} from "node:path";

const userDir = resolve(process.argv[2] || "");
if (!process.argv[2]) throw new Error("usage: node scripts/node-red-mqtt-announce.mjs <dir>");
const require = createRequire(resolve(userDir, "package.json"));

const aedes = require("aedes");
const broker = typeof aedes.Aedes?.createBroker === "function" ? await aedes.Aedes.createBroker() : (aedes.Aedes ? new aedes.Aedes() : aedes());
const server = createServer(broker.handle);
await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
const port = server.address().port;
const arrived = new Set();
broker.on("publish", (packet, client) => {
  if (client) arrived.add(packet.topic);
});

const flowFile = "announce-flows.json";
rmSync(resolve(userDir, flowFile), {force: true});
const RED = require("node-red");
RED.init(undefined, {
  userDir,
  flowFile,
  httpAdminRoot: false,
  httpNodeRoot: false,
  disableEditor: true,
  credentialSecret: "announce-check-only",
  logging: {console: {level: "warn"}}
});

const AVAILABILITY = "home/announce/lighting/availability";
const DISCOVERY = "homeassistant/sensor/nrha_announce-room_main_control/config";
function flows(withStatus) {
  return [
    {id: "announce-tab", type: "tab", label: "announce"},
    {id: "announce-broker", type: "mqtt-broker", name: "", broker: "127.0.0.1", port: String(port), clientid: "", usetls: false,
      protocolVersion: "4", keepalive: "60", cleansession: true, autoConnect: true},
    {id: "announce-room", type: "home-room-lighting-controller", z: "announce-tab", name: "", area: "announce", targets: "[{\"id\":\"main\"}]",
      publishState: true, discovery: true, idScheme: "node", discoveryPrefix: "homeassistant", initialTransitionSeconds: 1,
      wires: [["announce-out"], [], []]},
    {id: "announce-out", type: "mqtt out", z: "announce-tab", broker: "announce-broker", topic: "", qos: "", retain: "", wires: []},
    ...(withStatus ? [{id: "announce-status", type: "status", z: "announce-tab", scope: ["announce-out"], wires: [["announce-room"]]}] : [])
  ];
}

async function deploy(label, withStatus) {
  arrived.clear();
  await RED.runtime.flows.setFlows({user: null, flows: {flows: flows(withStatus)}, deploymentType: "full"});
  await new Promise((settled) => setTimeout(settled, 1500));
  const got = [AVAILABILITY, DISCOVERY].filter((topic) => arrived.has(topic));
  console.log(JSON.stringify({run: label, statusNode: withStatus, arrived: got}));
  return got.length === 2;
}

let failed = false;
try {
  await RED.start();
  if (await deploy("first start, no Status node", false)) {
    console.error("the check can't fail: the announcements arrived without the Status node");
    failed = true;
  }
  for (const label of ["full deploy", "full redeploy"]) {
    if (!(await deploy(label, true))) {
      console.error(`${label}: the room's availability and discovery didn't reach the broker`);
      failed = true;
    }
  }
} finally {
  await RED.stop();
  server.close();
  broker.close();
}
if (failed) process.exit(1);
console.log("Node-RED MQTT announce check passed: with a Status node on MQTT out, announcements reach the broker after it connects.");
process.exit(0);
