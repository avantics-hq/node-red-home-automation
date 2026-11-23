"use strict";

import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import test from "node:test";

interface Definition {
  defaults: Record<string, {value: unknown; validate?: (this: Record<string, unknown>, value: unknown) => boolean}>;
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

test("new nodes start with publishing off; saved flows keep their behaviour", () => {
  for (const [file, settings] of [["room-controller.html", ["publishState", "discovery"]], ["theatre-state-contract.html", ["discovery"]]] as const) {
    const definition = editorDefinition(file);
    const node: Record<string, unknown> = {};
    definition.onadd!.call(node);
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
