"use strict";

import assert from "node:assert/strict";
import {readdirSync, readFileSync} from "node:fs";
import {resolve} from "node:path";
import test from "node:test";
import {runInNewContext} from "node:vm";

// Each node reference page (docs-src/pages, "node" in its settings) must
// match the node's editor definition, so a setting added, renamed or
// re-defaulted in the editor can't leave its page behind.

const root = resolve(__dirname, "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

interface EditorDefinition {
  defaults: Record<string, {value?: unknown; type?: string}>;
  credentials?: Record<string, unknown>;
}

const nodeFiles = (JSON.parse(read("package.json")) as {"node-red": {nodes: Record<string, string>}})["node-red"].nodes;

// The definition the editor registers, from the node's HTML, with the
// editor's globals stubbed out.
function editorDefinition(type: string): EditorDefinition {
  const html = read(`nodes/${nodeFiles[type]!.split("/").pop()!.replace(/\.js$/, ".html")}`);
  let definition: EditorDefinition | undefined;
  const stub: unknown = new Proxy(function () {}, {get: () => stub, apply: () => stub});
  const RED = new Proxy({}, {
    get: (_, key) => key === "nodes"
      ? {registerType: (registered: string, value: EditorDefinition) => { if (registered === type) definition = value; }}
      : stub
  });
  for (const [, script] of html.matchAll(/<script type="text\/javascript">([\s\S]*?)<\/script>/g)) {
    runInNewContext(script!, {RED, $: stub, jQuery: stub, window: stub, document: stub});
  }
  assert.ok(definition, `${type} registers no editor definition`);
  return definition;
}

interface ReferencePage {file: string; node: string; text: string}

function referencePages(): ReferencePage[] {
  return readdirSync(resolve(root, "docs-src/pages"))
    .map((file) => {
      const text = read(`docs-src/pages/${file}`);
      const settings = JSON.parse(/^<!--([\s\S]*?)-->/.exec(text)![1]!) as {node?: string};
      return {file, node: settings.node ?? "", text};
    })
    .filter((page) => page.node);
}

const plain = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&quot;/g, "\"").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

test("every node the package registers has a reference page", () => {
  const documented = new Set(referencePages().map((page) => page.node));
  assert.deepEqual(Object.keys(nodeFiles).filter((type) => !documented.has(type)), []);
});

test("each reference page documents every editor setting of its node, and no others", () => {
  for (const page of referencePages()) {
    const definition = editorDefinition(page.node);
    const keys = [...Object.keys(definition.defaults), ...Object.keys(definition.credentials ?? {})];
    const rows = new Map([...page.text.matchAll(/<tr><td>[^<]*<span class="field">([\w]+) · [^<]*<\/span><\/td><td>([\s\S]*?)<\/td>/g)]
      .map(([, key, cell]) => [key!, plain(cell!)]));
    for (const key of keys) {
      assert.ok(rows.has(key) || new RegExp(`<code>${key}\\b`).test(page.text), `${page.file}: ${key} is not documented`);
    }
    for (const key of rows.keys()) {
      assert.ok(keys.includes(key), `${page.file}: the settings table lists ${key}, which ${page.node} doesn't have`);
    }
    for (const [key, cell] of rows) {
      const value = definition.defaults[key]?.value;
      // null: set when the node is added (onadd), so the page describes it.
      if (value === undefined || value === null) continue;
      // "_DEFAULT_" is the editor's marker for a name cleared when added.
      const expected = value === "" || value === "_DEFAULT_" ? ["Empty", "None"] : [typeof value === "string" ? value : JSON.stringify(value)];
      assert.ok(expected.some((text) => cell.includes(text)), `${page.file}: ${key} defaults to ${JSON.stringify(value)}, the page says "${cell}"`);
    }
  }
});
