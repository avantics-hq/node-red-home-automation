// The documentation site's menu drawer and search, shared by every page.
// The search index (search-index.js, written by scripts/build-docs.mjs)
// defines window.DOCS_SEARCH: one entry per page and per section.

const drawer = document.querySelector("#menu-drawer");
const menu = document.querySelector("#menu-button");
menu.addEventListener("click", () => {
  drawer.showModal();
  menu.setAttribute("aria-expanded", "true");
});
document.querySelector("#menu-close").addEventListener("click", () => drawer.close());
drawer.addEventListener("close", () => {
  menu.setAttribute("aria-expanded", "false");
  menu.focus();
});
// A click on the backdrop, outside the drawer, closes it.
drawer.addEventListener("click", (event) => {
  if (event.target !== drawer) return;
  const box = drawer.getBoundingClientRect();
  if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) drawer.close();
});
drawer.querySelectorAll("a").forEach((link) => link.addEventListener("click", () => drawer.close()));
matchMedia("(min-width:801px)").addEventListener("change", (event) => {
  if (event.matches && drawer.open) drawer.close();
});

const search = document.querySelector("#doc-search");
const results = document.querySelector("#search-results");
// A status region (role="status", polite by default) outside the results, so
// a screen reader hears how many results the query found as the list changes.
const status = document.querySelector("#search-status");
const entries = window.DOCS_SEARCH || [];
const MAX_RESULTS = 8;

// Entries containing every word of the query: titles first, then sections.
function find(query) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const scored = [];
  for (const entry of entries) {
    const heading = (entry.title + " " + (entry.section || "")).toLowerCase();
    const text = heading + " " + entry.text.toLowerCase();
    if (!words.every((word) => text.includes(word))) continue;
    const score = words.filter((word) => heading.includes(word)).length * 2 + (entry.section ? 0 : 1);
    scored.push({entry, score});
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, MAX_RESULTS).map(({entry}) => entry);
}

search.addEventListener("input", () => {
  const query = search.value.trim();
  results.replaceChildren();
  results.hidden = !query;
  if (!query) {
    status.textContent = "";
    return;
  }
  const label = document.createElement("p");
  label.textContent = "Search the documentation";
  results.append(label);
  const matches = find(query);
  for (const entry of matches) {
    const link = document.createElement("a");
    link.href = entry.url;
    link.textContent = entry.section ? entry.title + " › " + entry.section : entry.title;
    if (entry.section) link.className = "section-hit";
    const description = document.createElement("small");
    description.textContent = entry.description;
    link.append(description);
    results.append(link);
  }
  if (!matches.length) {
    const empty = document.createElement("p");
    empty.textContent = "Nothing matches “" + search.value + "”. Try cover, install or roadmap.";
    results.append(empty);
  }
  status.textContent = matches.length === 0 ? "No results" : matches.length === 1 ? "1 result" : matches.length + " results";
});
search.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    results.hidden = true;
    search.value = "";
    status.textContent = "";
  }
  if (event.key === "ArrowDown") {
    event.preventDefault();
    results.querySelector("a")?.focus();
  }
  if (event.key === "Enter") {
    event.preventDefault();
    results.querySelector("a")?.click();
  }
});
document.addEventListener("click", (event) => {
  if (!event.target.closest(".search")) results.hidden = true;
});

// The old home page's sections moved: send their links to where they are now.
const MOVED = {
  "#roadmap": "roadmap.html#milestones",
  "#roadmap-title": "roadmap.html#milestones",
  "#components": "roadmap.html#components",
  "#components-title": "roadmap.html#components",
  "#status-title": "roadmap.html",
  "#principles-title": "index.html#core-ideas"
};
if (MOVED[location.hash] && !document.getElementById(location.hash.slice(1))) location.replace(MOVED[location.hash]);
