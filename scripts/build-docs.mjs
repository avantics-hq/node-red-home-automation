// Builds the GitHub Pages documentation in docs/ from docs-src/: each page's
// content (docs-src/pages/*.html) inside one shared shell (top bar, menu,
// phone drawer, "On this page" rail and footer), the menu from
// docs-src/nav.json, the version from package.json, and a search index of
// every page and section. docs/assets/site.css and site.js are written by
// hand; docs/images is left alone.
//
// Usage: node scripts/build-docs.mjs          writes docs/
//        node scripts/build-docs.mjs --check  exits 1 if docs/ differs
import {readFileSync, readdirSync, writeFileSync} from "node:fs";
import {fileURLToPath} from "node:url";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");

export const REPOSITORY = "https://github.com/avantics-hq/node-red-home-automation";

// The pages, in reading order: the menu's own entries, top to bottom, so the
// previous and next links follow the menu.
export const PAGES = JSON.parse(read("docs-src/nav.json"))
  .flatMap((group) => group.items.map((item) => item.href))
  .filter((href) => !/^[a-z]+:/i.test(href))
  .map((href) => href.replace(/\.html$/, ""));

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

// Every menu entry is a page; the entry for the page being shown is marked.
function navLink(item, current) {
  const here = item.href === current ? " aria-current=\"page\"" : "";
  const away = isOutside(item.href) ? " ↗" : "";
  return `<a href="${escapeHtml(item.href)}"${here}>${escapeHtml(item.label)}${away}</a>`;
}

function renderNav(nav, current) {
  const groups = nav.map((group) =>
    `<div class="nav-group"><p class="nav-label">${escapeHtml(group.label)}</p>${group.items.map((item) => navLink(item, current)).join("")}</div>`
  ).join("");
  return `<nav class="doc-nav" aria-label="Documentation">${groups}</nav>`;
}

// Docs, then the page's menu group and entry, as the menu shows them.
function renderBreadcrumb(place) {
  const steps = [place.group, place.label].map((step) => `<span aria-hidden="true">/</span><span>${escapeHtml(step)}</span>`).join("");
  return `<nav class="breadcrumb" aria-label="Breadcrumb"><a href="index.html">Docs</a>${steps}</nav>`;
}

// Where each page sits in the menu; every page has an entry.
function menuPlaces(nav) {
  const places = new Map();
  for (const group of nav) for (const item of group.items) places.set(item.href, {group: group.label, label: item.label});
  return places;
}

// Previous and next pages, in PAGES order.
function renderPager(previous, next) {
  const links = [
    previous && `<a href="${previous.file}"><small>Previous</small>← ${escapeHtml(previous.title)}</a>`,
    next && `<a href="${next.file}"><small>Continue</small>${escapeHtml(next.title)} →</a>`
  ].filter(Boolean).join("");
  return `<nav class="pager" aria-label="Adjacent pages">${links}</nav>`;
}

function renderPage(page, nav, version, previous, next, place) {
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
${renderBreadcrumb(place)}<p class="page-kind">${escapeHtml(place.group)}</p><h1>${escapeHtml(page.title)}</h1><p class="lead">${page.lead}</p>
<details class="mobile-toc"><summary>On this page</summary>${tocLinks}</details>
${page.content}
${renderPager(previous, next)}
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
  const unlisted = readdirSync(new URL("docs-src/pages/", root)).map((file) => file.replace(/\.html$/, "")).filter((name) => !PAGES.includes(name));
  if (unlisted.length) throw new Error(`docs-src/pages has pages with no entry in docs-src/nav.json: ${unlisted.join(", ")}`);
  const pages = PAGES.map(readPage);
  const places = menuPlaces(nav);
  const files = new Map();
  const index = [];
  for (const [i, page] of pages.entries()) {
    const place = places.get(page.file);
    files.set(page.file, renderPage(page, nav, version, pages[i - 1], pages[i + 1], place));
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
