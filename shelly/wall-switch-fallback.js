// Wall-switch fallback for a Shelly Gen2-or-later relay behind a wall switch.
//
// The relay's input is detached: Node-RED reads the presses over MQTT and the
// relay stays on to power a smart bulb. While the device's MQTT connection is
// down, or Node-RED has announced itself offline, a press at the wall toggles
// the relay instead, so the switch still cuts and restores the bulb's power.
// When both are back, the relay is switched on again, but only if a fallback
// press switched it off. Outside the fallback the script never touches the
// relay.
//
// Until anything arrives on nodeRedTopic, the script can't tell whether
// Node-RED is up, so it falls back only while MQTT is down.
//
// Set CONFIG below, paste the script into the device (Scripts), start it and
// turn on "Run on startup". MQTT must be enabled on the device.

let CONFIG = {
  // The topic Node-RED's MQTT broker node publishes its birth, close and will
  // messages on, and the payload that means Node-RED is up.
  nodeRedTopic: "node-red/status",
  nodeRedOnline: "online",
  // The detached input the wall switch is wired to, and the relay it falls
  // back to switching.
  inputId: 0,
  switchId: 0
};

let inputKey = "input:" + CONFIG.inputId;
let switchKey = "switch:" + CONFIG.switchId;
// Whether anything has arrived on nodeRedTopic, and what it said.
let heard = false;
let nodeRedUp = false;
let falling = false;
// True only while the relay is off because a fallback press switched it off.
let cutByFallback = false;

function inFallback() {
  return !MQTT.isConnected() || (heard && !nodeRedUp);
}

// Called after anything that can change the fallback. On recovery, restore
// the bulb's power only if the fallback cut it: a relay a person switched off
// stays off.
function update() {
  let now = inFallback();
  if (falling && !now) {
    if (cutByFallback) {
      Shelly.call("Switch.Set", {id: CONFIG.switchId, on: true, tag: "fallback-ended"});
      cutByFallback = false;
      console.log("wall-switch fallback: off, relay switched back on");
    } else {
      console.log("wall-switch fallback: off");
    }
  } else if (!falling && now) {
    console.log("wall-switch fallback: on");
  }
  falling = now;
}

function onToggled(result) {
  if (result && typeof result.was_on === "boolean") cutByFallback = result.was_on;
}

function press() {
  if (inFallback()) Shelly.call("Switch.Toggle", {id: CONFIG.switchId, tag: "fallback-press"}, onToggled);
}

function onNodeRedStatus(topic, message) {
  heard = true;
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

function onStatus(status) {
  if (!status.delta) return;
  // The relay is on again, by any route: nothing for the fallback to restore.
  if (status.component === switchKey && status.delta.output === true) cutByFallback = false;
  // A toggle switch: each change of the input's state is a press.
  if (status.component === inputKey && typeof status.delta.state === "boolean") press();
}

// A push button: each push is a press.
function onEvent(event) {
  if (event.component !== inputKey) return;
  let name = event.info ? event.info.event : event.event;
  if (name === "single_push" || name === "double_push" || name === "triple_push" || name === "long_push") press();
}

function checkHeard() {
  if (!heard) {
    console.log("wall-switch fallback: nothing on " + CONFIG.nodeRedTopic + " after a minute; falling back only while MQTT is down. Check the broker node's birth, close and will messages.");
  }
}

MQTT.setConnectHandler(onConnect);
MQTT.setDisconnectHandler(onDisconnect);
Shelly.addStatusHandler(onStatus);
Shelly.addEventHandler(onEvent);
subscribe();
update();
console.log("wall-switch fallback: waiting for " + CONFIG.nodeRedTopic);
Timer.set(60000, false, checkHeard);
