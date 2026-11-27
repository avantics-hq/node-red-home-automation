// Builds the GitHub Pages documentation in docs/ from docs-src/: each page's
// content (docs-src/pages/*.html) inside one shared shell (top bar, menu,
// phone drawer, "On this page" rail and footer), the menu from
// docs-src/nav.json, the version from package.json, and a search index of
// every page and section. docs/assets/site.css and site.js are written by
// hand; docs/images is left alone.
//
// Usage: node scripts/build-docs.mjs          writes docs/
//        node scripts/build-docs.mjs --check  exits 1 if docs/ differs
import {readFileSync, writeFileSync} from "node:fs";
import {fileURLToPath} from "node:url";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");

export const REPOSITORY = "https://github.com/avantics-hq/node-red-home-automation";

// The pages, in reading order.
export const PAGES = [
  "index",
  "guide-room-lighting", "guide-motion-occupancy", "guide-wall-switches", "guide-house-schedule",
  "guide-covers", "home-theatre", "guide-home-assistant", "guide-device-adapters",
  "node-cover-controller", "contract-examples", "releases", "roadmap"
];

const escapeHtml = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Text of an HTML fragment, for search and descriptions.
export function plainText(fragment) {
  return fragment
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// A page's settings (a JSON comment at the top) and its content.
export function readPage(name) {
  const source = read(`docs-src/pages/${name}.html`);
  const match = /^<!--([\s\S]*?)-->\n/.exec(source);
  if (!match) throw new Error(`docs-src/pages/${name}.html must start with its settings in a comment`);
  return {name, file: `${name}.html`, ...JSON.parse(match[1]), content: source.slice(match[0].length).trim()};
}

// Each top-level section: its id, heading and text.
export function sections(content) {
  return [...content.matchAll(/<section id="([^"]+)"><h2>([\s\S]*?)<\/h2>([\s\S]*?)<\/section>/g)]
    .map(([, id, heading, body]) => ({id, heading: plainText(heading), text: plainText(body)}));
}

// Menu entries open pages on this site. These are the only outside links the
// site's chrome may carry: the source repository (top bar) and the contributing
// guide (menu). test/docs-site.test.ts fails on any other menu entry that
// leaves the site.
export const OUTSIDE_LINKS = new Set([REPOSITORY, `${REPOSITORY}/blob/main/CONTRIBUTING.md`]);
const isOutside = (href) => /^[a-z]+:/i.test(href);

function navLink(item, current) {
  const here = item.href === current ? " aria-current=\"page\"" : "";
  const away = isOutside(item.href) ? " ↗" : "";
  return `<a href="${escapeHtml(item.href)}"${here}>${escapeHtml(item.label)}${away}</a>`;
}

function renderNav(nav, current) {
  const groups = nav.map((group) => {
    const inner = group.families
      ? group.families.map((family) => {
        const open = family.items.some((item) => item.href.split("#")[0] === current) ? " open" : "";
        return `<details${open}><summary>${escapeHtml(family.label)}</summary>${family.items.map((item) => navLink(item, current)).join("")}</details>`;
      }).join("")
      : group.items.map((item) => navLink(item, current)).join("");
    return `<div class="nav-group"><p class="nav-label">${escapeHtml(group.label)}</p>${inner}</div>`;
  }).join("");
  return `<nav class="doc-nav" aria-label="Documentation">${groups}</nav>`;
}

function renderPage(page, nav, version) {
  const tocLinks = sections(page.content).map(({id, heading}) => `<a href="#${id}">${escapeHtml(heading)}</a>`).join("");
  const menu = renderNav(nav, page.file);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(page.htmlTitle)}</title>
<meta name="description" content="${escapeHtml(page.description)}">
<link rel="stylesheet" href="assets/site.css">
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="topbar"><a class="brand" href="index.html"><span class="mark" aria-hidden="true">HA</span>Node-RED Home Automation</a><span class="version">${escapeHtml(version)}</span><button class="menu-button" id="menu-button" aria-controls="menu-drawer" aria-expanded="false">Menu</button><div class="search"><label class="sr-only" for="doc-search">Search the documentation</label><input id="doc-search" type="search" placeholder="Search the documentation…" autocomplete="off" aria-controls="search-results"><p class="sr-only" id="search-status" role="status"></p><div class="search-results" id="search-results" hidden></div></div><a class="source" href="${REPOSITORY}">Source ↗</a></header>
<dialog id="menu-drawer" aria-labelledby="drawer-title"><div class="drawer-head"><strong id="drawer-title">Documentation</strong><button id="menu-close" autofocus>Close</button></div>${menu}</dialog>
<div class="layout"><aside class="sidebar">${menu}</aside><main id="main" tabindex="-1">
<nav class="breadcrumb" aria-label="Breadcrumb"><a href="index.html">Docs</a><span aria-hidden="true">/</span><span>${escapeHtml(page.kind)}</span></nav><p class="page-kind">${escapeHtml(page.kind)}</p><h1>${escapeHtml(page.title)}</h1><p class="lead">${page.lead}</p>
<details class="mobile-toc"><summary>On this page</summary>${tocLinks}</details>
${page.content}
<footer class="page-footer"><span>Package ${escapeHtml(version)} · MIT</span><a href="${REPOSITORY}#readme">Read the README ↗</a></footer>
</main><aside class="toc" aria-label="On this page"><p>On this page</p>${tocLinks}</aside></div>
<script src="assets/search-index.js"></script>
<script src="assets/site.js"></script>
</body>
</html>
`;
}

// Every file the build writes, by path under docs/.
export function buildDocs() {
  const version = JSON.parse(read("package.json")).version;
  const nav = JSON.parse(read("docs-src/nav.json"));
  const pages = PAGES.map(readPage);
  const files = new Map();
  const index = [];
  for (const page of pages) {
    files.set(page.file, renderPage(page, nav, version));
    index.push({title: page.title, description: page.description || plainText(page.lead), url: page.file, text: plainText(page.lead)});
    for (const section of sections(page.content)) {
      index.push({title: page.title, section: section.heading, description: section.text.slice(0, 110), url: `${page.file}#${section.id}`, text: section.text});
    }
  }
  files.set("assets/search-index.js", `// Written by scripts/build-docs.mjs.\nwindow.DOCS_SEARCH = ${JSON.stringify(index, null, 1)};\n`);
  return files;
}

function main() {
  const files = buildDocs();
  if (process.argv.includes("--check")) {
    const stale = [...files].filter(([path, content]) => {
      try {
        return readFileSync(new URL(`docs/${path}`, root), "utf8") !== content;
      } catch {
        return true;
      }
    }).map(([path]) => `docs/${path}`);
    if (stale.length) {
      console.error(`Out of date, run npm run docs: ${stale.join(", ")}`);
      process.exitCode = 1;
    } else {
      console.log(`docs/ matches its build (${files.size} files).`);
    }
    return;
  }
  for (const [path, content] of files) writeFileSync(new URL(`docs/${path}`, root), content);
  console.log(`Wrote ${files.size} files to docs/.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
