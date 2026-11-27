"use strict";

import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import test from "node:test";

interface Definition {
  category?: string;
  oneditprepare?: (this: Record<string, unknown>) => void;
  oneditsave?: (this: Record<string, unknown>) => void;
  defaults: Record<string, {value: unknown; type?: string; required?: boolean; validate?: (this: Record<string, unknown>, value: unknown) => boolean}>;
  outputs?: number;
  outputLabels?: string[] | ((this: Record<string, unknown>, index: number) => string);
  onadd?: (this: Record<string, unknown>) => void;
}

// Runs a node's editor script against a stand-in RED and returns its
// definition. Outside an open edit dialog, jQuery finds no inputs.
function editorDefinition(file: string, $: unknown = () => ({length: 0})): Definition {
  const html = readFileSync(resolve(__dirname, "../../nodes", file), "utf8");
  const script = /<script type="text\/javascript">([\s\S]*?)<\/script>/.exec(html)![1]!;
  let definition: Definition | undefined;
  const RED = {
    nodes: {registerType: (_name: string, value: Definition) => { definition = value; }},
    validators: {number: () => () => true}
  };
  new Function("RED", "$", script)(RED, $);
  assert.ok(definition);
  return definition;
}

// A node as the editor creates one from the palette: every default, then onadd.
function newNode(definition: Definition): Record<string, unknown> {
  const node: Record<string, unknown> = Object.fromEntries(Object.entries(definition.defaults).map(([key, {value}]) => [key, value]));
  definition.onadd!.call(node);
  return node;
}

const ONADD_NODES = ["room-controller.html", "theatre-state-contract.html", "occupancy-fusion.html", "motion-policy.html",
  "avr-controller.html", "house-schedule-mqtt.html", "cover-controller.html"];

test("importing, pasting or restoring a saved node keeps its settings; only a new node gets the new-node ones", () => {
  for (const file of ONADD_NODES) {
    const definition = editorDefinition(file);
    // As the editor imports: the saved values only (no defaults filled in), then onadd.
    for (const saved of [
      {name: "", publishState: true, discovery: true, idScheme: null},
      {name: "Hall lights", publishState: true, discovery: true, idScheme: "area"},
      {publishState: true, discovery: true}
    ]) {
      const node: Record<string, unknown> = {...saved};
      definition.onadd!.call(node);
      assert.deepEqual(node, saved, `${file}: ${JSON.stringify(saved)}`);
    }
    const fresh = newNode(definition);
    assert.equal(fresh.name, "", `${file}: the marker doesn't stay`);
    assert.equal(fresh.idScheme, "node", file);
  }
});

test("new nodes start with publishing off; saved flows keep their behaviour", () => {
  for (const [file, settings] of [["room-controller.html", ["publishState", "discovery"]], ["theatre-state-contract.html", ["discovery"]]] as const) {
    const definition = editorDefinition(file);
    const node = newNode(definition);
    for (const setting of settings) {
      assert.equal(node[setting], false, `${file} ${setting} for a new node`);
      // null means "not set", so the editor never fills in "off" for an older node.
      assert.equal(definition.defaults[setting]!.value, null, `${file} ${setting} default`);
    }
  }
});

test("the editor flags a missing area only when publishing needs it", () => {
  const room = editorDefinition("room-controller.html").defaults.area!.validate!;
  assert.equal(room.call({publishState: false, discovery: false}, ""), true);
  assert.equal(room.call({publishState: true, discovery: false}, ""), false);
  assert.equal(room.call({publishState: null, discovery: null}, ""), false, "an older node, loaded with null, publishes");
  assert.equal(room.call({}, ""), false, "an older node without the fields publishes");
  assert.equal(room.call({publishState: true, discovery: true}, "hall"), true);
  const contract = editorDefinition("theatre-state-contract.html").defaults.area!.validate!;
  assert.equal(contract.call({discovery: false, baseTopic: "media/theatre"}, ""), true);
  assert.equal(contract.call({discovery: false, baseTopic: ""}, ""), false, "the default base topic needs it");
  assert.equal(contract.call({discovery: true, baseTopic: "media/theatre"}, ""), false);
  assert.equal(contract.call({discovery: true, baseTopic: ""}, "hall"), true);
});

test("JSON fields with no sensible default are flagged until filled in, matching the runtime", () => {
  const examples = Object.fromEntries(["Home theatre activity.json", "Home theatre equipment.json"].flatMap((file) =>
    (JSON.parse(readFileSync(resolve(__dirname, "../../examples", file), "utf8")) as Array<Record<string, unknown>>)
      .map((node) => [String(node.type), node])));
  const fields = [
    ["activity-lighting-controller.html", "profiles", "home-activity-lighting-controller"],
    ["source-capability-controller.html", "sources", "home-source-capability-controller"],
    ["theatre-activity-controller.html", "activityProfiles", "home-theatre-activity-controller"],
    ["theatre-state-contract.html", "activities", "home-theatre-state-contract"]
  ] as const;
  for (const [file, field, type] of fields) {
    const setting = editorDefinition(file).defaults[field]!;
    const valid = (value: unknown) => setting.validate!.call({}, value);
    assert.equal(valid(setting.value), false, `${file} ${field}: the empty default is flagged`);
    assert.equal(valid(examples[type]![field]), true, `${file} ${field}: the example's value passes`);
    for (const junk of ["", "{broken", "null", "5", field === "activities" ? "{}" : "[]"]) {
      assert.equal(valid(junk), false, `${file} ${field}: ${JSON.stringify(junk)}`);
    }
  }
});

test("the discovery prefix field matches the runtime on both publishing nodes", () => {
  for (const file of ["room-controller.html", "theatre-state-contract.html"]) {
    const setting = editorDefinition(file).defaults.discoveryPrefix!;
    const valid = (value: unknown) => setting.validate!.call({}, value);
    assert.equal(setting.value, "homeassistant", file);
    assert.equal(valid("homeassistant"), true, file);
    assert.equal(valid("/ha/discovery/"), true, file);
    for (const value of ["", " ", "/", "ha/+", "#"]) assert.equal(valid(value), false, `${file} ${JSON.stringify(value)}`);
  }
});

test("new nodes name their Home Assistant entities after the node; saved nodes keep the area scheme", () => {
  for (const file of ["room-controller.html", "theatre-state-contract.html"]) {
    const definition = editorDefinition(file);
    assert.equal(definition.defaults.idScheme?.value, null, `${file}: a saved node without the setting is not set`);
    assert.equal(newNode(definition).idScheme, "node", file);
  }
});

test("occupancy and motion publishing start off, and a new node is named after itself", () => {
  for (const file of ["occupancy-fusion.html", "motion-policy.html", "avr-controller.html"]) {
    const definition = editorDefinition(file);
    assert.equal(definition.defaults.publishState?.value, false, file);
    assert.equal(definition.defaults.discovery?.value, false, file);
    assert.equal(newNode(definition).idScheme, "node", file);
  }
});

test("the contract editor asks for an area only where the runtime needs one", () => {
  const area = editorDefinition("theatre-state-contract.html").defaults.area!;
  const valid = (value: string, node: Record<string, unknown>) => area.validate!.call(node, value);
  assert.equal(valid("", {discovery: true, baseTopic: "media/theatre", idScheme: "node"}), true, "new contract with a base topic");
  assert.equal(valid("", {discovery: true, baseTopic: "media/theatre", idScheme: null}), false, "saved contract with discovery");
  assert.equal(valid("", {discovery: false, baseTopic: "media/theatre", idScheme: null}), true);
  assert.equal(valid("", {discovery: false, baseTopic: "", idScheme: "node"}), false, "the default base topic needs it");
  assert.equal(valid("!!!", {discovery: false, baseTopic: "x", idScheme: "node"}), false);
});

test("a house schedule is a config node rooms may reference; its MQTT node names its entities after the node", () => {
  const house = editorDefinition("house-schedule.html");
  assert.deepEqual([house.category, house.defaults.name?.value, house.defaults.wakeTime?.value, house.defaults.bedTime?.value],
    ["config", "house", "07:00", "23:00"]);
  const room = editorDefinition("room-controller.html").defaults.houseSchedule;
  assert.deepEqual([room?.value, room?.type, room?.required], ["", "home-house-schedule", false], "not required: none means its own times");
  const mqtt = editorDefinition("house-schedule-mqtt.html");
  assert.deepEqual([mqtt.defaults.schedule?.type, mqtt.defaults.schedule?.required, mqtt.defaults.idScheme?.value], ["home-house-schedule", true, null]);
  assert.equal(newNode(mqtt).idScheme, "node");
});

test("a cover group has the group's result, then one output per member labelled from Members", () => {
  const group = editorDefinition("cover-group.html");
  assert.equal(group.defaults.outputs?.value, 3, "two members by default, and the result");
  const labels = group.outputLabels as (this: Record<string, unknown>, index: number) => string;
  const node = {members: "[\"left\",\"middle\",\"right\"]"};
  assert.deepEqual([0, 1, 2, 3].map((index) => labels.call(node, index)), ["group result", "left", "middle", "right"]);
});

// An edit dialog for the cover group: its Members input and the hidden
// outputs field, then what the Node-RED 5.0.10 editor does on Done: count the
// outputs from the port map (red.js 43889-43925) and move or drop each wire
// (updateNodeProperties, red.js 40927-40946). Wires are {port: cover}.
function editCoverGroup(members: string[], wires: Record<number, string>, edit: string[]) {
  const fields: Record<string, string> = {"#node-input-members": JSON.stringify(members), "#node-input-outputs": ""};
  const handlers: Array<() => void> = [];
  const $ = (selector: string) => ({
    val(value?: string) {
      if (value === undefined) return fields[selector];
      fields[selector] = value;
      return this;
    },
    on(_events: string, handler: () => void) { handlers.push(handler); }
  });
  const group = editorDefinition("cover-group.html", $) as Definition & {oneditprepare: (this: Record<string, unknown>) => void};
  group.oneditprepare.call({members: JSON.stringify(members)});
  fields["#node-input-members"] = JSON.stringify(edit);
  for (const handler of handlers) handler();
  // A plain number sets the count and moves nothing; a map moves wires.
  const value = JSON.parse(fields["#node-input-outputs"]!) as number | Record<string, string>;
  const map = typeof value === "number" ? {} : value;
  const count = typeof value === "number" ? value
    : Object.entries(map).filter(([key, port]) => Number.isNaN(Number(key)) || port !== "-1").length;
  const moved: Record<number, string> = {};
  for (const [port, cover] of Object.entries(wires)) {
    const to = Object.hasOwn(map, port) ? map[port]! : port;
    if (to !== "-1" && Number(to) < count) moved[Number(to)] = cover;
  }
  return {count, wires: moved};
}

test("editing a cover group's members moves each member's wire with its name", () => {
  const wired = {0: "result", 1: "left cover", 2: "mid cover", 3: "right cover"};
  assert.deepEqual(editCoverGroup(["left", "mid", "right"], wired, ["left", "mid", "right"]), {count: 4, wires: wired}, "untouched");
  assert.deepEqual(editCoverGroup(["left", "mid", "right"], wired, ["left", "right"]),
    {count: 3, wires: {0: "result", 1: "left cover", 2: "right cover"}}, "remove the middle: right's wire moves to port 2, mid's goes");
  assert.deepEqual(editCoverGroup(["left", "mid", "right"], wired, ["right", "mid", "left"]),
    {count: 4, wires: {0: "result", 1: "right cover", 2: "mid cover", 3: "left cover"}}, "reorder swaps the wires");
  assert.deepEqual(editCoverGroup(["left", "mid", "right"], wired, ["left", "mid", "right", "extra"]),
    {count: 5, wires: wired}, "add at the end keeps them");
  assert.deepEqual(editCoverGroup(["left", "right"], {0: "result", 1: "left cover", 2: "right cover"}, ["left", "extra", "right"]),
    {count: 4, wires: {0: "result", 1: "left cover", 3: "right cover"}}, "add in the middle moves right along");
});

test("a cover starts with publishing off, named after the node, and has a fourth output", () => {
  const cover = editorDefinition("cover-controller.html");
  assert.deepEqual([cover.defaults.publishState?.value, cover.defaults.discovery?.value, cover.defaults.topicName?.value, cover.defaults.idScheme?.value],
    [false, false, "", null]);
  // No default name: flagged while it publishes, not otherwise.
  const name = (value: string, node: Record<string, unknown>) => cover.defaults.topicName!.validate!.call(node, value);
  assert.deepEqual([name("", {publishState: true}), name("", {discovery: true}), name("left", {publishState: true}), name("", {publishState: false})],
    [false, false, true, true]);
  assert.equal(newNode(cover).idScheme, "node");
  assert.deepEqual(cover.outputLabels, ["device commands", "state and results", "moving", "MQTT publications"]);
});

test("the shelly cover adapter has no default device and two labelled outputs", () => {
  const definition = editorDefinition("shelly-cover.html");
  assert.deepEqual([definition.defaults.topicPrefix!.value, definition.defaults.channel!.value], ["", 0]);
  const valid = (key: string, value: unknown) => definition.defaults[key]!.validate!.call({}, value);
  assert.deepEqual([valid("topicPrefix", ""), valid("topicPrefix", "shellyplus2pm-a8032ab12345"), valid("topicPrefix", "a/#")], [false, true, false]);
  assert.deepEqual([valid("channel", 1), valid("channel", "-1"), valid("channel", "1.5")], [true, false, false]);
  assert.deepEqual([definition.outputs, definition.outputLabels], [2, ["to the device (MQTT out)", "to the cover controller"]]);
});

test("the shelly switch adapter has no default device and three labelled outputs", () => {
  const definition = editorDefinition("shelly-switch.html");
  assert.deepEqual([definition.defaults.topicPrefix!.value, definition.defaults.channel!.value], ["", 0]);
  const valid = (key: string, value: unknown) => definition.defaults[key]!.validate!.call({}, value);
  assert.deepEqual([valid("topicPrefix", ""), valid("topicPrefix", "shellyplus1pm-a8032ab12345"), valid("topicPrefix", "a/+")], [false, true, false]);
  assert.deepEqual([valid("channel", 2), valid("channel", "-1")], [true, false]);
  assert.deepEqual([definition.outputs, definition.outputLabels],
    [3, ["to the device (MQTT out)", "to the backlighting controller", "to the display controller"]]);
});

test("the zigbee2mqtt cover adapter defaults the base topic, has no default device, and two labelled outputs", () => {
  const definition = editorDefinition("z2m-cover.html");
  assert.deepEqual([definition.defaults.baseTopic!.value, definition.defaults.friendlyName!.value], ["zigbee2mqtt", ""]);
  const valid = (key: string, value: unknown) => definition.defaults[key]!.validate!.call({}, value);
  assert.deepEqual([valid("friendlyName", ""), valid("friendlyName", "garden/blind"), valid("friendlyName", "a+b")], [false, true, false]);
  assert.deepEqual([valid("baseTopic", ""), valid("baseTopic", "z2m"), valid("baseTopic", "z2m/#")], [false, true, false]);
  assert.deepEqual([definition.outputs, definition.outputLabels], [2, ["to the device (MQTT out)", "to the cover controller"]]);
});

test("a display node's projector power meter host is optional, so no display node is shown invalid for it", () => {
  const definition = editorDefinition("display-mode-controller.html");
  const {projectorPowerMeterHost: setting} = definition.defaults;
  assert.deepEqual([setting!.required, setting!.validate], [undefined, undefined]);
  assert.equal(definition.outputs, 3);
  assert.deepEqual(definition.outputLabels, ["projector IR fallback", "state and results", "projector power queries"]);
});

// A saved node as the editor holds it: only the properties its defaults
// name (Node-RED's importNodes copies those and nothing else).
function asLoaded(definition: Definition, saved: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.keys(definition.defaults).filter((key) => key in saved).map((key) => [key, saved[key]]));
}

// A stand-in jQuery over an edit dialog's input values.
function dialog(values: Record<string, unknown> = {}) {
  return Object.assign((selector: string) => ({
    val(value?: unknown) {
      if (value === undefined) return values[selector];
      values[selector] = value;
      return this;
    },
    prop() { return this; },
    on() { return this; },
    trigger() { return this; },
    length: 1
  }), {values});
}

test("a display node saved before 5.0 keeps its meter host through the editor, and saving moves it to the new name", () => {
  const $ = dialog();
  const definition = editorDefinition("display-mode-controller.html", $);
  const node = asLoaded(definition, {type: "home-display-mode-controller", projectorMeterHost: "meter.example"});
  assert.equal(node.projectorMeterHost, "meter.example", "kept as loaded, so the runtime still reads it");
  definition.oneditprepare!.call(node);
  assert.equal($.values["#node-input-projectorPowerMeterHost"], "meter.example");
  definition.oneditsave!.call(node);
  assert.equal(node.projectorMeterHost, "");
  // Clearing the filled-in host and saving leaves none: the node then reads
  // the projector's power from the flow.
  const migrated = asLoaded(definition, {type: "home-display-mode-controller", projectorMeterHost: "meter.example"});
  definition.oneditprepare!.call(migrated);
  $.values["#node-input-projectorPowerMeterHost"] = "";
  definition.oneditsave!.call(migrated);
  assert.equal(migrated.projectorMeterHost, "");
});

test("a receiver saved before 5.0 keeps its volume bounds through the editor, isn't invalid, and saving moves them to dB", () => {
  const $ = dialog();
  const definition = editorDefinition("avr-controller.html", $);
  const node = asLoaded(definition, {type: "home-avr-controller", minVolume: 10, maxVolume: 50, publishState: false});
  assert.deepEqual([node.minVolume, node.maxVolume], [10, 50], "kept as loaded, so the runtime still reads them");
  const valid = (key: string) => definition.defaults[key]!.required !== true && definition.defaults[key]!.validate!.call(node, node[key]);
  assert.deepEqual([valid("minVolumeDb"), valid("maxVolumeDb")], [true, true]);
  definition.oneditprepare!.call(node);
  assert.deepEqual([$.values["#node-input-minVolumeDb"], $.values["#node-input-maxVolumeDb"]], [-70, -30]);
  definition.oneditsave!.call(node);
  assert.deepEqual([node.minVolume, node.maxVolume], ["", ""]);
  // Neither form, or a non-number, is invalid.
  assert.equal(definition.defaults.minVolumeDb!.validate!.call({minVolume: ""}, ""), false);
  assert.equal(definition.defaults.minVolumeDb!.validate!.call({}, "quiet"), false);
  assert.equal(definition.defaults.minVolumeDb!.validate!.call({}, -60), true);
});

test("the screen viewing position has no default: empty uses the screen's own open, and a saved position is kept", () => {
  const definition = editorDefinition("display-mode-controller.html");
  const setting = definition.defaults.screenOpenPosition!;
  assert.deepEqual([setting.value, setting.required], ["", undefined]);
  const valid = (value: unknown) => setting.validate!.call({}, value);
  assert.deepEqual([valid(""), valid(82), valid("82"), valid(100), valid(0), valid(101), valid("wide")], [true, true, true, true, false, false, false]);
  // A node saved before 5.0 with 82 keeps it as loaded, and it is valid; a
  // hand-written node without the key stays without it (the screen's own open).
  const saved = asLoaded(definition, {type: "home-display-mode-controller", screenOpenPosition: 82});
  assert.deepEqual([saved.screenOpenPosition, valid(saved.screenOpenPosition)], [82, true]);
  assert.equal(Object.hasOwn(asLoaded(definition, {type: "home-display-mode-controller"}), "screenOpenPosition"), false);
});
