import assert from "node:assert/strict";
import {pathToFileURL} from "node:url";

export {assert};

export function runWhenMain(moduleUrl, name, run) {
  const entryUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
  if (moduleUrl === entryUrl) {
    console.log(JSON.stringify({name, ...run()}, null, 2));
  }
}
