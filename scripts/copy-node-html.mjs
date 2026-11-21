import {cpSync, mkdirSync, readdirSync} from "node:fs";

const source = new URL("../nodes/", import.meta.url);
const destination = new URL("../dist/nodes/", import.meta.url);
mkdirSync(destination, {recursive: true});
for (const name of readdirSync(source)) {
  if (name.endsWith(".html")) cpSync(new URL(name, source), new URL(name, destination));
}
