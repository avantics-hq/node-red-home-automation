"use strict";

import assert from "node:assert/strict";
import {existsSync, readFileSync} from "node:fs";
import {resolve} from "node:path";
import test from "node:test";
import {pathToFileURL} from "node:url";

interface DocsBuild {
  buildDocs(): Map<string, string>;
  PAGES: string[];
  REPOSITORY: string;
  OUTSIDE_LINKS: Set<string>;
}

const root = resolve(__dirname, "../..");
const docs = (path: string) => resolve(root, "docs", path);

async function build(): Promise<DocsBuild> {
  return await import(pathToFileURL(resolve(root, "scripts/build-docs.mjs")).href) as DocsBuild;
}

// GitHub's anchor for a README heading: lower case, punctuation dropped,
// spaces as hyphens, and a repeated heading numbered from -1.
function readmeAnchors(): Set<string> {
  const anchors = new Set<string>();
  for (const [, heading] of readFileSync(resolve(root, "README.md"), "utf8").matchAll(/^#{1,6} (.+)$/gm)) {
    const slug = heading!.toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, "").replace(/ /g, "-");
    let anchor = slug;
    for (let n = 1; anchors.has(anchor); n += 1) anchor = `${slug}-${n}`;
    anchors.add(anchor);
  }
  return anchors;
}

test("docs/ is what scripts/build-docs.mjs builds: run npm run docs after changing docs-src", async () => {
  const {buildDocs} = await build();
  for (const [path, content] of buildDocs()) {
    assert.ok(existsSync(docs(path)), `docs/${path} is missing`);
    assert.equal(readFileSync(docs(path), "utf8"), content, `docs/${path} is out of date`);
  }
});

test("every page shows the package's version, and no design-preview leftovers", async () => {
  const {buildDocs} = await build();
  const version = (JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {version: string}).version;
  for (const [path, content] of buildDocs()) {
    if (!path.endsWith(".html")) continue;
    assert.ok(content.includes(`<span class="version">${version}</span>`), path);
    assert.ok(content.includes(`Package ${version} · MIT`), path);
    assert.doesNotMatch(content, /preview|mockup|three pages/i, path);
  }
});

test("every link between pages, and every README section the menu names, exists", async () => {
  const {buildDocs, REPOSITORY} = await build();
  const files = buildDocs();
  const ids = new Map([...files].filter(([path]) => path.endsWith(".html"))
    .map(([path, content]) => [path, new Set([...content.matchAll(/ id="([^"]+)"/g)].map(([, id]) => id))]));
  const readme = readmeAnchors();
  for (const [path, content] of files) {
    if (!path.endsWith(".html")) continue;
    for (const [, href] of content.matchAll(/ href="([^"]+)"/g)) {
      if (href!.startsWith(`${REPOSITORY}#`)) {
        const anchor = href!.slice(REPOSITORY.length + 1);
        assert.ok(anchor === "readme" || readme.has(anchor), `${path}: README has no section #${anchor}`);
        continue;
      }
      if (/^[a-z]+:/.test(href!)) continue;
      const [file, anchor] = href!.split("#");
      const target = file || path;
      assert.ok(target.startsWith("assets/") ? existsSync(docs(target)) : ids.has(target), `${path}: ${href} names no page`);
      if (anchor) assert.ok(ids.get(target)?.has(anchor), `${path}: ${href} names no section`);
    }
  }
});

test("search covers every page and its sections", async () => {
  const {buildDocs, PAGES} = await build();
  const index = buildDocs().get("assets/search-index.js")!;
  const entries = JSON.parse(index.slice(index.indexOf("["), index.lastIndexOf("]") + 1)) as Array<{url: string; section?: string}>;
  for (const page of PAGES) {
    assert.ok(entries.some(({url, section}) => url === `${page}.html` && !section), page);
    assert.ok(entries.some(({url, section}) => url.startsWith(`${page}.html#`) && section), `${page} sections`);
  }
});

type MenuItem = {label: string; href: string};
const menuItems = () =>
  (JSON.parse(readFileSync(resolve(root, "docs-src/nav.json"), "utf8")) as Array<{items: MenuItem[]}>).flatMap((group) => group.items);

test("every menu entry is a whole page on this site, apart from the listed outside links", async () => {
  const {PAGES, OUTSIDE_LINKS} = await build();
  for (const {label, href} of menuItems()) {
    if (/^[a-z]+:/i.test(href)) {
      assert.ok(OUTSIDE_LINKS.has(href), `${label} leaves the site (${href}): give it a page, or remove it from the menu`);
    } else {
      assert.ok(!href.includes("#"), `${label} (${href}) points into a section: the menu lists pages only`);
      assert.ok(PAGES.includes(href.replace(/\.html$/, "")), `${label} (${href}) names no page on the site`);
    }
  }
});

test("no two menu entries share a target or a label", () => {
  const items = menuItems();
  for (const key of ["href", "label"] as const) {
    const seen = items.map((item) => item[key]);
    assert.deepEqual(seen.filter((value, i) => seen.indexOf(value) !== i), [], `menu entries with the same ${key}`);
  }
});

test("each page's menu marks only that page as current", async () => {
  const {buildDocs} = await build();
  for (const [path, content] of buildDocs()) {
    if (!path.endsWith(".html")) continue;
    for (const [, menu] of content.matchAll(/<nav class="doc-nav"[^>]*>([\s\S]*?)<\/nav>/g)) {
      const current = [...menu!.matchAll(/<a href="([^"]+)" aria-current="page">/g)].map(([, href]) => href);
      assert.deepEqual(current, [path], path);
    }
  }
});

// Majors from 5 have a section on the releases page; minor and patch releases
// are described in the GitHub release notes.
test("the releases page has a section for every major version from 5", () => {
  const readme = readFileSync(resolve(root, "README.md"), "utf8");
  const page = readFileSync(resolve(root, "docs-src/pages/releases.html"), "utf8");
  const majors = [...readme.matchAll(/^### (\d+)\.0\.0$/gm)].map(([, major]) => Number(major)).filter((major) => major >= 5);
  assert.ok(majors.includes(5), "README has no 5.0.0 notes");
  for (const major of majors) {
    assert.ok(page.includes(`<section id="v${major}"><h2>Version ${major}</h2>`),
      `docs-src/pages/releases.html has no section for version ${major}`);
  }
});
