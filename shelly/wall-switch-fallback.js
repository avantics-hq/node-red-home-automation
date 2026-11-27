// Wall-switch fallback for a Shelly Gen2-or-later relay behind a wall switch.
//
// The relay's input is detached: Node-RED reads the presses over MQTT and the
// relay stays on to power a smart bulb. While the device's MQTT connection is
// down, or Node-RED reports itself offline, a press at the wall toggles the
// relay instead, so the switch still cuts and restores the bulb's power. When
// both are back, the relay is switched on again. Outside the fallback the
// script never touches the relay.
//
// Set CONFIG below, paste the script into the device (Scripts), start it and
// turn on "Run on startup". MQTT must be enabled on the device.

let CONFIG = {
  // The topic Node-RED's MQTT broker node publishes its birth and will
  // messages on, and the payload that means Node-RED is up.
  nodeRedTopic: "node-red/status",
  nodeRedOnline: "online",
  // The detached input the wall switch is wired to, and the relay it falls
  // back to switching.
  inputId: 0,
  switchId: 0
};

let inputKey = "input:" + CONFIG.inputId;
let nodeRedUp = false;
let falling = true;

function inFallback() {
  return !MQTT.isConnected() || !nodeRedUp;
}

// Called after anything that can change the fallback: on recovery, switch the
// relay back on so the bulb has power for Node-RED to control.
function update() {
  let now = inFallback();
  if (falling && !now) {
    Shelly.call("Switch.Set", {id: CONFIG.switchId, on: true, tag: "fallback-ended"});
    console.log("wall-switch fallback: off, relay switched on");
  } else if (!falling && now) {
    console.log("wall-switch fallback: on");
  }
  falling = now;
}

function press() {
  if (inFallback()) Shelly.call("Switch.Toggle", {id: CONFIG.switchId, tag: "fallback-press"});
}

function onNodeRedStatus(topic, message) {
  nodeRedUp = String(message).trim().toLowerCase() === CONFIG.nodeRedOnline;
  update();
}

// A fresh subscription receives the retained birth or will message, so
// subscribe again whenever the connection comes back.
function subscribe() {
  MQTT.unsubscribe(CONFIG.nodeRedTopic);
  MQTT.subscribe(CONFIG.nodeRedTopic, onNodeRedStatus);
}

function onConnect() {
  subscribe();
  update();
}

function onDisconnect() {
  nodeRedUp = false;
  update();
}

// A toggle switch: each change of the input's state is a press.
function onStatus(status) {
  if (status.component !== inputKey || !status.delta) return;
  if (typeof status.delta.state === "boolean") press();
}

// A push button: each push is a press.
function onEvent(event) {
  if (event.component !== inputKey) return;
  let name = event.info ? event.info.event : event.event;
  if (name === "single_push" || name === "double_push" || name === "triple_push" || name === "long_push") press();
}

MQTT.setConnectHandler(onConnect);
MQTT.setDisconnectHandler(onDisconnect);
Shelly.addStatusHandler(onStatus);
Shelly.addEventHandler(onEvent);
subscribe();
update();
