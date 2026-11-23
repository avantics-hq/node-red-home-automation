#!/usr/bin/env node
// Regenerates each docs/images/*.svg from the *.mmd diagram source beside it,
// using mermaid-cli as a tool (run through npx, not a dependency). The first
// line of each SVG records the SHA-256 of its source:
//   <!-- source-sha256: <hex> -->
// so a check can tell when the source changed without the image being redrawn.
import {createHash} from "node:crypto";
import {execFileSync} from "node:child_process";
import {mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

const MERMAID_CLI = "@mermaid-js/mermaid-cli@12.2.0";
const directory = new URL("../docs/images/", import.meta.url).pathname;

// A neutral theme on an opaque white background reads the same on light and
// dark pages. Labels are SVG text rather than embedded HTML, so the image
// draws the same wherever it is shown as a plain <img>.
const mermaidConfig = {theme: "neutral", htmlLabels: false, flowchart: {htmlLabels: false, wrappingWidth: 260}};
// Chromium's sandbox fails when run as root in a container; the only input is
// our own diagram source.
const puppeteerConfig = {args: ["--no-sandbox"]};

const work = mkdtempSync(join(tmpdir(), "diagrams-"));
try {
  writeFileSync(join(work, "mermaid.json"), JSON.stringify(mermaidConfig));
  writeFileSync(join(work, "puppeteer.json"), JSON.stringify(puppeteerConfig));
  const sources = readdirSync(directory).filter((name) => name.endsWith(".mmd"));
  if (!sources.length) throw new Error(`no .mmd sources in ${directory}`);
  for (const name of sources) {
    const source = join(directory, name);
    const target = source.replace(/\.mmd$/, ".svg");
    execFileSync("npx", [
      "--yes", MERMAID_CLI,
      "--input", source,
      "--output", target,
      "--backgroundColor", "white",
      "--configFile", join(work, "mermaid.json"),
      "--puppeteerConfigFile", join(work, "puppeteer.json"),
      "--quiet"
    ], {stdio: "inherit"});
    const hash = createHash("sha256").update(readFileSync(source)).digest("hex");
    const svg = readFileSync(target, "utf8").replace(/^<!-- source-sha256: [0-9a-f]{64} -->\n/, "");
    writeFileSync(target, `<!-- source-sha256: ${hash} -->\n${svg.endsWith("\n") ? svg : svg + "\n"}`);
    console.log(`${name} -> ${name.replace(/\.mmd$/, ".svg")} (${hash.slice(0, 12)})`);
  }
} finally {
  rmSync(work, {recursive: true, force: true});
}
