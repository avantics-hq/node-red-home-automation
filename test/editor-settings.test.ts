"use strict";

import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import test from "node:test";

interface Definition {
  defaults: Record<string, {value: unknown; validate?: (this: Record<string, unknown>, value: unknown) => boolean}>;
  outputs?: number;
  outputLabels?: string[] | ((this: Record<string, unknown>, index: number) => string);
  onadd?: (this: Record<string, unknown>) => void;
}

// Runs a node's editor script against a stand-in RED and returns its
// definition. Outside an open edit dialog, jQuery finds no inputs.
function editorDefinition(file: string): Definition {
  const html = readFileSync(resolve(__dirname, "../../nodes", file), "utf8");
  const script = /<script type="text\/javascript">([\s\S]*?)<\/script>/.exec(html)![1]!;
  let definition: Definition | undefined;
  const RED = {
    nodes: {registerType: (_name: string, value: Definition) => { definition = value; }},
    validators: {number: () => () => true}
  };
  const $ = () => ({length: 0});
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
  "avr-controller.html", "house-schedule.html"];

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

test("a house schedule starts with publishing off and names itself after the node; rooms default to their own times", () => {
  const house = editorDefinition("house-schedule.html");
  assert.deepEqual([house.defaults.publishState?.value, house.defaults.discovery?.value, house.defaults.houseName?.value], [false, false, "house"]);
  assert.equal(newNode(house).idScheme, "node");
  assert.equal(editorDefinition("room-controller.html").defaults.timesFrom?.value, null, "not set: the room's own times");
});

test("a cover group has the group's result, then one output per member labelled from Members", () => {
  const group = editorDefinition("cover-group.html");
  assert.equal(group.defaults.outputs?.value, 3, "two members by default, and the result");
  const labels = group.outputLabels as (this: Record<string, unknown>, index: number) => string;
  const node = {members: "[\"left\",\"middle\",\"right\"]"};
  assert.deepEqual([0, 1, 2, 3].map((index) => labels.call(node, index)), ["group result", "left", "middle", "right"]);
});
