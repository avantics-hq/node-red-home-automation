"use strict";

import assert from "node:assert/strict";
import test from "node:test";
import {transitionBacklighting, type BacklightingState} from "../lib/backlighting-controller";
import {transitionDisplay, type DisplayConfig, type DisplayState} from "../lib/display-mode-controller";
import {
  normaliseShellySwitchConfig,
  transitionShellySwitch,
  type ShellySwitchMessage,
  type ShellySwitchState
} from "../lib/shelly-switch";

const config = normaliseShellySwitchConfig({topicPrefix: "shellyplus1pm-test", channel: 0});
const at = (seconds: number): Date => new Date(Date.parse("2026-11-27T10:00:00Z") + seconds * 1000);

function apply(state: Partial<ShellySwitchState> | undefined, msg: ShellySwitchMessage, seconds = 0) {
  return transitionShellySwitch(state, msg, config, at(seconds));
}
const status = (fields: Record<string, unknown>) => ({topic: "shellyplus1pm-test/status/switch:0", payload: JSON.stringify({id: 0, ...fields})});
const notify = (change: Record<string, unknown>) =>
  ({topic: "shellyplus1pm-test/events/rpc", payload: {method: "NotifyStatus", params: {ts: 1, "switch:0": {id: 0, ...change}}}});
const backlightingCommand = (operation: string, generation = 3, power = "on") =>
  ({backlightingCommand: {operation, requestId: `r-${generation}`, generation, power, attempt: 1}});
const query = (generation = 5) =>
  ({payload: "query", display_command: {device: "projector", operation: "query_power", requestId: "p", generation, attempt: 1}});
const sent = (result: ReturnType<typeof apply>) => result.publications.map(({topic, payload}) => [topic, payload]);

test("the settings name the device's prefix and switch, with no default device", () => {
  assert.deepEqual(normaliseShellySwitchConfig({topicPrefix: " dev/ ", channel: "2"}), {topicPrefix: "dev", channel: 2});
  assert.throws(() => normaliseShellySwitchConfig({}), /topic prefix is required/);
  assert.throws(() => normaliseShellySwitchConfig({topicPrefix: "a", channel: "1.5"}), /whole number/);
});

test("the backlighting controller's commands and the display's power query become the switch's MQTT control commands", () => {
  assert.deepEqual(sent(apply(undefined, backlightingCommand("set_power", 3, "on"))), [["shellyplus1pm-test/command/switch:0", "on"]]);
  assert.deepEqual(sent(apply(undefined, backlightingCommand("set_power", 3, "off"))), [["shellyplus1pm-test/command/switch:0", "off"]]);
  // observe and the power query ask for a fresh status, not the last one.
  assert.deepEqual(sent(apply(undefined, backlightingCommand("observe"))), [["shellyplus1pm-test/command/switch:0", "status_update"]]);
  assert.deepEqual(sent(apply(undefined, query())), [["shellyplus1pm-test/command/switch:0", "status_update"]]);
  assert.deepEqual(sent(apply(undefined, {display_command: {device: "screen", operation: "query_position", generation: 1}})), []);
  const second = normaliseShellySwitchConfig({topicPrefix: "dev", channel: 1});
  assert.deepEqual(transitionShellySwitch(undefined, backlightingCommand("observe"), second, at(0)).publications[0]?.topic, "dev/command/switch:1");
});

test("the output reads as backlighting power with the last command's generation, and the power as the projector's watts", () => {
  // Before any backlighting command there is no generation to tag a reading with.
  let result = apply(undefined, status({output: true, apower: 140.2}), 1);
  assert.deepEqual(result.backlighting, []);
  assert.deepEqual(result.display, [{display: {kind: "observed", device: "projector", watts: 140.2, source: "switch", observedAt: at(1).toISOString()}}]);
  result = apply(result.state, backlightingCommand("observe", 7), 2);
  result = apply(result.state, status({output: false, apower: 0}), 2.5);
  assert.deepEqual(result.backlighting, [{backlighting: {kind: "observed", generation: 7, power: "off", observedAt: at(2.5).toISOString()}}]);
  // A change carries only what changed: an output change is a backlighting reading, a power change a meter reading.
  const output = apply(result.state, notify({output: true}), 3);
  assert.deepEqual([output.backlighting.length, output.display.length], [1, 0]);
  const power = apply(output.state, notify({apower: 12}), 4);
  assert.deepEqual([power.backlighting.length, power.display.map(({display}) => display.kind === "observed" && display.watts)], [0, [12]]);
  // A relay without metering reports no power, so nothing goes to the display.
  assert.deepEqual(apply(undefined, status({output: true}), 5).display, []);
});

test("offline, a command or query fails at once; back online, the node asks for a fresh status", () => {
  let result = apply(undefined, {topic: "shellyplus1pm-test/online", payload: "false"});
  assert.equal(result.status.text, "offline");
  result = apply(result.state, backlightingCommand("set_power", 9), 1);
  assert.deepEqual([result.publications, result.backlighting], [[], [{backlighting: {kind: "command_result", generation: 9, ok: false, reason: "offline"}}]]);
  result = apply(result.state, query(4), 1);
  assert.deepEqual([result.publications, result.display], [[], [{display: {kind: "transport_failed", device: "projector", operation: "query_power", generation: 4, reason: "offline"}}]]);
  result = apply(result.state, {topic: "shellyplus1pm-test/online", payload: true}, 2);
  assert.deepEqual(sent(result), [["shellyplus1pm-test/command/switch:0", "status_update"]]);
  // Anything else, such as its own command echoed back, is ignored.
  assert.deepEqual(sent(apply(result.state, {topic: "shellyplus1pm-test/command/switch:0", payload: "on"})), []);
});

// A relay as its MQTT API behaves, enough for round trips: on, off and
// status_update, with a load drawing `load()` watts while it is on.
function relay(load: () => number) {
  const device = {output: false};
  const full = () => ({topic: "shellyplus1pm-test/status/switch:0", payload: JSON.stringify({id: 0, output: device.output, apower: device.output ? load() : 0})});
  return {
    device,
    receive(payload: string) {
      if (payload === "on" || payload === "off") {
        device.output = payload === "on";
        return [notify({output: device.output})];
      }
      return payload === "status_update" ? [full()] : [];
    }
  };
}

test("a round trip through the real backlighting controller: switched on, confirmed from the relay's own report", () => {
  const backlightingConfig = {pollMs: 1000, confirmationTimeoutMs: 5000, maxAttempts: 2};
  const {device, receive} = relay(() => 30);
  let lights: ReturnType<typeof transitionBacklighting> | undefined;
  let adapter: Partial<ShellySwitchState> | undefined;
  const queue: Array<{to: "lights" | "adapter" | "device"; message: unknown}> = [];
  const run = (seconds: number) => {
    while (queue.length) {
      const {to, message} = queue.shift()!;
      if (to === "lights") {
        lights = transitionBacklighting(lights?.state as Partial<BacklightingState> | undefined, {backlighting: message as never}, backlightingConfig, at(seconds));
        for (const command of lights.commands) queue.push({to: "adapter", message: {backlightingCommand: command}});
      } else if (to === "adapter") {
        const result = apply(adapter, message as ShellySwitchMessage, seconds);
        adapter = result.state;
        for (const {backlighting} of result.backlighting) queue.push({to: "lights", message: backlighting});
        for (const {payload} of result.publications) queue.push({to: "device", message: payload});
      } else {
        for (const reply of receive(message as string)) queue.push({to: "adapter", message: reply});
      }
    }
  };
  queue.push({to: "lights", message: {kind: "intent", requestId: "tv-1", generation: 1, power: "on"}});
  run(0);
  for (let seconds = 1; seconds <= 6 && lights!.state.phase !== "ready"; seconds += 1) {
    queue.push({to: "lights", message: {kind: "tick", generation: 1}});
    run(seconds);
  }
  assert.equal(device.output, true);
  assert.equal(lights!.state.phase, "ready");
  assert.equal(lights!.events.at(-1)?.theatre.status, "ready");
});

test("a round trip through the real display controller: the relay's meter is the projector's power, read on each query", () => {
  const displayConfig: DisplayConfig = {screenOpenPosition: null, screenTolerance: 2, pollMs: 1000, queryTimeoutMs: 1000, tvTimeoutMs: 4000,
    screenTimeoutMs: 5000, projectorWarmupMs: 6000, projectorMinimumWarmupMs: 2000, projectorShutdownConfirmMs: 2000, projectorCooldownMs: 5000,
    maxAttempts: 2, projectorOnWatts: 20, projectorOffWatts: 10};
  // The projector stays plugged into the relay; its infrared toggle starts the lamp, which then draws 155 W.
  const lamp = {on: false};
  const {receive} = relay(() => (lamp.on ? 155 : 2));
  receive("on");
  const tv = {power: "on"};
  const screen = {position: 0};
  let display: ReturnType<typeof transitionDisplay> | undefined;
  let adapter: Partial<ShellySwitchState> | undefined;
  const queue: Array<{to: "display" | "adapter" | "device"; message: unknown}> = [];
  const run = (seconds: number) => {
    while (queue.length) {
      const {to, message} = queue.shift()!;
      if (to === "display") {
        display = transitionDisplay(display?.state as Partial<DisplayState> | undefined, {display: message as never}, displayConfig, at(seconds));
        for (const command of display.commands) {
          // The display's own transports, answering under the command's generation.
          const answer = (values: Record<string, unknown>) => queue.push({to: "display", message: {kind: "observed", generation: command.generation, source: "test", ...values}});
          if (command.device === "projector" && command.operation === "query_power") queue.push({to: "adapter", message: {payload: "query", display_command: command}});
          else if (command.device === "projector" && command.operation === "power_toggle") lamp.on = !lamp.on;
          else if (command.device === "tv") {
            if (command.operation === "set_power") tv.power = String(command.power);
            answer({device: "tv", power: tv.power});
          } else if (command.device === "screen") {
            if (command.operation === "open") screen.position = 100;
            if (command.operation === "close") screen.position = 0;
            answer({device: "screen", position: screen.position, state: screen.position === 100 ? "open" : "closed"});
          }
        }
      } else if (to === "adapter") {
        const result = apply(adapter, message as ShellySwitchMessage, seconds);
        adapter = result.state;
        for (const {display: reading} of result.display) queue.push({to: "display", message: reading});
        for (const {payload} of result.publications) queue.push({to: "device", message: payload});
      } else {
        for (const reply of receive(message as string)) queue.push({to: "adapter", message: reply});
      }
    }
  };
  queue.push({to: "display", message: {kind: "intent", requestId: "projector-1", generation: 1, mode: "projector"}});
  run(0);
  for (let seconds = 1; seconds <= 20 && display!.state.phase !== "ready" && display!.state.phase !== "failed"; seconds += 1) {
    queue.push({to: "display", message: {kind: "tick", generation: 1}});
    run(seconds);
  }
  assert.equal(display!.state.phase, "ready", JSON.stringify(display!.state.failure));
  assert.equal(display!.state.observed.projector?.power, "on");
  assert.equal(display!.state.observed.projector?.watts, 155);
  assert.equal(tv.power, "standby");
});
