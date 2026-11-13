/* quant-ph topic scanner — static client, no build step, no dependencies. */

const PAGE_SIZE = 25;
const TOPICS_KEY = "my-topics";

const state = {
  papers: [],
  topics: new Map(),      // id -> {id, label, keywords, regex} — all of them the reader's own
  matches: new Map(),     // paper id -> Set of topic ids
  newest: null,           // most recent submission in the dataset
  days: 1,
  selected: new Set(),
  editing: null,          // topic id the form is editing, null when it creates a new one
  mode: "any",
  query: "",
  page: 1,
};

const el = (id) => document.getElementById(id);

/* ---------- topic matching ---------- */

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Keyword -> regex source. Three accommodations for real abstracts:
 *  hyphens and spaces are interchangeable ("non-Markovian" / "non Markovian"),
 *  a trailing plural is allowed ("quantum neural network" hits "...networks"),
 *  and boundaries are only required where the keyword ends in a word char
 *  ("Yb+" would never match if we demanded \b after the plus sign). */
function keywordSource(keyword) {
  const body = escapeRegex(keyword.toLowerCase()).replace(/\\?[-\s]+/g, "[\\s-]+");
  const prefix = /^\w/.test(keyword) ? "\\b" : "";
  const suffix = /\w$/.test(keyword) ? "(?:e?s)?\\b" : "";
  return prefix + body + suffix;
}

const buildTopic = ({ id, label, keywords }) => ({
  id, label, keywords,
  regex: new RegExp(keywords.map(keywordSource).join("|"), "g"),
});

/** Keywords come from a textarea: comma or newline separated, in any spacing. */
const parseKeywords = (raw) =>
  raw.split(/[,\n]/).map((keyword) => keyword.trim()).filter(Boolean);

/** Precompute topic hits once; filtering afterwards is a set lookup. */
function indexPapers() {
  for (const paper of state.papers) {
    const haystack = `${paper.title} ${paper.abstract}`.toLowerCase();
    const hits = new Set();
    for (const topic of state.topics.values()) {
      topic.regex.lastIndex = 0;
      if (topic.regex.test(haystack)) hits.add(topic.id);
    }
    state.matches.set(paper.id, hits);
  }
}

/* ---------- free-text query ---------- */

/** Split into bare words and "quoted phrases"; every term must appear.
 *  A term is anchored at the start of a word but left open at the end, which
 *  is the only combination that gets all three of these right:
 *    "entangl"        still narrows while you type -> entanglement
 *    "ion"            means ions, not dimens(ion)s or informat(ion)
 *    "spin squeezing" also finds "spin-squeezing" (hyphens == spaces) */
function parseQuery(raw) {
  const terms = [];
  const pattern = /"([^"]+)"|(\S+)/g;
  let match;
  while ((match = pattern.exec(raw)) !== null) {
    const text = (match[1] || match[2]).trim();
    if (!text) continue;
    const body = escapeRegex(text).replace(/\\?[-\s]+/g, "[\\s-]+");
    const source = (/^\w/.test(text) ? "\\b" : "") + body;
    terms.push({ text, regex: new RegExp(source, "i") });
  }
  return terms;
}

function matchesQuery(paper, terms) {
  if (!terms.length) return true;
  const haystack = `${paper.title} ${paper.abstract} ${paper.authors.join(" ")}`;
  return terms.every((term) => term.regex.test(haystack));
}

/* ---------- filtering ---------- */

function cutoff() {
  // Measured from the newest submission, not from "now": arXiv publishes in
  // daily batches, so a literal 24h window is empty for most of the day.
  return new Date(state.newest.getTime() - state.days * 86400000);
}

/** state.papers arrives newest-first from the scraper, so filtering preserves
 *  the chronological order and nothing needs re-sorting. */
function currentResults() {
  const since = cutoff();
  const terms = parseQuery(state.query);
  const selected = [...state.selected];

  return state.papers.filter((paper) => {
    if (new Date(paper.published) < since) return false;
    if (!matchesQuery(paper, terms)) return false;
    if (!selected.length) return true;
    const hits = state.matches.get(paper.id);
    return state.mode === "all"
      ? selected.every((id) => hits.has(id))
      : selected.some((id) => hits.has(id));
  });
}

/** Per-topic counts within the current time window, ignoring topic selection. */
function topicCounts() {
  const since = cutoff();
  const terms = parseQuery(state.query);
  const counts = new Map();
  for (const paper of state.papers) {
    if (new Date(paper.published) < since) continue;
    if (!matchesQuery(paper, terms)) continue;
    for (const id of state.matches.get(paper.id)) {
      counts.set(id, (counts.get(id) || 0) + 1);
    }
  }
  return counts;
}

/* ---------- rendering ---------- */

const escapeHtml = (text) =>
  text.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char]));

/** Mark the matches with sentinels, escape, then swap in the <mark> tags, so a
 *  term like "amp" can never land inside an HTML entity produced by escaping. */
function highlight(text, terms) {
  if (!terms.length) return escapeHtml(text);
  const pattern = new RegExp(`(${terms.map((term) => term.regex.source).join("|")})`, "gi");
  return escapeHtml(text.replace(pattern, "\u0000$1\u0001"))
    .replaceAll("\u0000", "<mark>")
    .replaceAll("\u0001", "</mark>");
}

function formatDate(iso) {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric", month: "short", year: "numeric",
  });
}

function formatAuthors(authors) {
  if (authors.length <= 6) return authors.join(", ");
  return `${authors.slice(0, 5).join(", ")} + ${authors.length - 5} more`;
}

/** The edit and delete buttons sit next to the label, not inside it: a click
 *  anywhere within a <label> would otherwise toggle the checkbox as well. */
function renderTopic(topic, counts) {
  const count = counts.get(topic.id) || 0;
  const checked = state.selected.has(topic.id) ? "checked" : "";
  return `<div class="topic-row">
    <label class="topic ${count ? "" : "empty"}">
      <input type="checkbox" value="${topic.id}" ${checked}>
      <span class="topic-label">${escapeHtml(topic.label)}</span>
      <span class="count">${count}</span>
    </label>
    <button class="row-action edit" data-topic="${topic.id}" title="Edit this topic">✎</button>
    <button class="row-action delete" data-topic="${topic.id}" title="Delete this topic">×</button>
  </div>`;
}

function renderTopics() {
  const counts = topicCounts();
  const topics = [...state.topics.values()];

  el("topics").innerHTML = topics.length
    ? topics.map((topic) => renderTopic(topic, counts)).join("")
    : `<p class="hint empty-topics">
        No topics yet. A topic is a name and a few keywords, matched against
        titles and abstracts — make one for whatever you actually read.
      </p>`;

  // Combining one topic with itself means nothing; the control only earns its
  // space once there are two.
  el("match-mode").hidden = topics.length < 2;
}

/* ---------- the topic form ---------- */

/** Counting as you type is the whole point of the form: it is the only way to
 *  find out that "QC" matches half the archive before saving it. */
function previewTopic() {
  const keywords = parseKeywords(el("topic-keywords").value);
  if (!keywords.length) {
    el("topic-preview").textContent = "Add at least one keyword, separated by commas.";
    return;
  }
  const regex = new RegExp(keywords.map(keywordSource).join("|"), "i");
  const since = cutoff();
  const inWindow = state.papers.filter((paper) => new Date(paper.published) >= since);
  const hits = inWindow.filter((paper) => regex.test(`${paper.title} ${paper.abstract}`));
  const sample = hits.slice(0, 2).map((paper) => paper.title).join(" · ");
  el("topic-preview").innerHTML =
    `Matches <strong>${hits.length}</strong> of the ${inWindow.length} papers in this time window.` +
    (sample ? `<br><span class="sample">${escapeHtml(sample)}</span>` : "");
}

function openForm(id) {
  state.editing = id || null;
  const topic = id ? state.topics.get(id) : null;
  el("topic-label").value = topic ? topic.label : "";
  el("topic-keywords").value = topic ? topic.keywords.join(", ") : "";
  el("topic-form").hidden = false;
  el("topic-new").hidden = true;
  previewTopic();
  el("topic-label").focus();
}

function closeForm() {
  state.editing = null;
  el("topic-form").hidden = true;
  el("topic-new").hidden = false;
  el("topics-status").textContent = "";
}

function renderActiveFilters() {
  const chips = [...state.selected].map((id) => {
    const topic = state.topics.get(id);
    return `<button class="chip" data-topic="${id}">${escapeHtml(topic.label)} <span>×</span></button>`;
  });
  el("active-filters").innerHTML = chips.length
    ? `${chips.join("")}<span class="chip-note">${state.mode === "all" ? "all required" : "any of them"}</span>`
    : "";
}

function renderPapers(results) {
  const terms = parseQuery(state.query);
  const pages = Math.max(1, Math.ceil(results.length / PAGE_SIZE));
  state.page = Math.min(state.page, pages);
  const slice = results.slice((state.page - 1) * PAGE_SIZE, state.page * PAGE_SIZE);

  if (!results.length) {
    el("papers").innerHTML = `<p class="empty-state">
      No paper matches these filters in this time window.<br>
      Try a wider window, or drop one of the topics.
    </p>`;
    el("pager").innerHTML = "";
    return;
  }

  el("papers").innerHTML = slice
    .map((paper) => {
      const hits = [...state.matches.get(paper.id)]
        .filter((id) => state.topics.has(id))
        .map((id) => {
          const active = state.selected.has(id) ? "badge active" : "badge";
          return `<span class="${active}">${escapeHtml(state.topics.get(id).label)}</span>`;
        })
        .join("");
      const crossLists = paper.categories.filter((category) => category !== "quant-ph");
      return `<article class="paper">
        <div class="paper-meta">
          <time>${formatDate(paper.published)}</time>
          ${paper.version > 1 ? `<span class="tag">v${paper.version}</span>` : ""}
          ${crossLists.length ? `<span class="tag">${escapeHtml(crossLists.join(" · "))}</span>` : ""}
          <span class="arxiv-id">${escapeHtml(paper.id)}</span>
        </div>
        <h3><a href="${paper.abs_url}" target="_blank" rel="noopener">${highlight(paper.title, terms)}</a></h3>
        <p class="authors">${escapeHtml(formatAuthors(paper.authors))}</p>
        ${hits ? `<div class="badges">${hits}</div>` : ""}
        <details class="abstract">
          <summary>Abstract</summary>
          <p>${highlight(paper.abstract, terms)}</p>
          ${paper.comment ? `<p class="comment">${escapeHtml(paper.comment)}</p>` : ""}
          ${paper.journal_ref ? `<p class="comment">${escapeHtml(paper.journal_ref)}</p>` : ""}
        </details>
        <div class="links">
          <a href="${paper.abs_url}" target="_blank" rel="noopener">arXiv</a>
          <a href="${paper.pdf_url}" target="_blank" rel="noopener">PDF</a>
          ${paper.doi ? `<a href="https://doi.org/${encodeURIComponent(paper.doi)}" target="_blank" rel="noopener">DOI</a>` : ""}
        </div>
      </article>`;
    })
    .join("");

  el("pager").innerHTML = pages > 1
    ? `<button id="prev" ${state.page === 1 ? "disabled" : ""}>← previous</button>
       <span>page ${state.page} of ${pages}</span>
       <button id="next" ${state.page === pages ? "disabled" : ""}>next →</button>`
    : "";
}

/** The group's own recent submissions — a static list, not affected by filters. */
function renderGroup(payload) {
  const days = payload.window_days;
  el("group-hint").innerHTML = payload.group_url
    ? `Last ${days} days from <a href="${payload.group_url}" target="_blank" rel="noopener">${escapeHtml(payload.group_name)}</a>`
    : `Last ${days} days`;

  if (!payload.papers.length) {
    el("group-papers").innerHTML =
      `<li class="group-empty">No submissions in the last ${days} days.</li>`;
    return;
  }

  el("group-papers").innerHTML = payload.papers
    .map((paper) => `<li class="group-item">
      <time>${formatDate(paper.published)}</time>
      <a href="${paper.abs_url}" target="_blank" rel="noopener">${escapeHtml(paper.title)}</a>
      <p class="group-members">${escapeHtml(paper.members.join(", "))}</p>
    </li>`)
    .join("");
}

function render() {
  const results = currentResults();
  const window = { 1: "in the last day", 7: "in the last week", 30: "in the last month" }[state.days];
  const noun = results.length === 1 ? "paper" : "papers";
  const filtered = state.selected.size || state.query ? " matching your filters" : "";
  el("result-count").textContent = `${results.length} ${noun} ${window}${filtered}`;
  renderTopics();
  renderActiveFilters();
  renderPapers(results);
  syncUrl();
}

/* ---------- the reader's own topics, kept in localStorage ---------- */

const isTopic = (value) =>
  value && typeof value.label === "string" && Array.isArray(value.keywords) &&
  value.keywords.every((keyword) => typeof keyword === "string");

/** Ids end up in shared URLs, so they are derived from the label rather than
 *  from a counter: a link keeps working after a reload, and two people who
 *  both made a "Gaussian states" topic can read each other's links. */
function topicId(label) {
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "topic";
  let id = base;
  for (let n = 2; state.topics.has(id); n++) id = `${base}-${n}`;
  return id;
}

function loadTopics() {
  let stored = [];
  try {
    stored = JSON.parse(localStorage.getItem(TOPICS_KEY) || "[]");
  } catch (error) {
    console.warn("could not read your topics:", error);
  }
  if (!Array.isArray(stored)) return;
  for (const topic of stored.filter(isTopic)) {
    const id = typeof topic.id === "string" && topic.id ? topic.id : topicId(topic.label);
    state.topics.set(id, buildTopic({ ...topic, id }));
  }
}

function saveTopics() {
  try {
    const plain = [...state.topics.values()].map(({ id, label, keywords }) => ({ id, label, keywords }));
    localStorage.setItem(TOPICS_KEY, JSON.stringify(plain));
  } catch (error) {
    console.warn("could not save your topics:", error);
  }
}

/* ---------- export / import, so a topic list can outlive one browser ---------- */

function exportTopics() {
  const plain = [...state.topics.values()].map(({ id, label, keywords }) => ({ id, label, keywords }));
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(plain, null, 2)], { type: "application/json" })
  );
  // In the document and revoked a tick later: Firefox ignores a click on a
  // detached anchor, and revoking in the same tick can cancel the download.
  const link = document.body.appendChild(document.createElement("a"));
  link.href = url;
  link.download = "my-topics.json";
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

async function importTopics(file) {
  let incoming;
  try {
    incoming = JSON.parse(await file.text());
  } catch (error) {
    el("topics-status").textContent = "That file is not valid JSON.";
    return;
  }
  const valid = Array.isArray(incoming) ? incoming.filter(isTopic) : [];
  if (!valid.length) {
    el("topics-status").textContent = "No topics in that file — expected a list of {label, keywords}.";
    return;
  }

  // Importing the same file twice should be a no-op, so a label already in the
  // list is skipped rather than duplicated under "gaussian-states-2".
  const taken = new Set([...state.topics.values()].map((topic) => topic.label.toLowerCase()));
  let added = 0;
  for (const topic of valid) {
    if (taken.has(topic.label.toLowerCase())) continue;
    taken.add(topic.label.toLowerCase());
    const id = topicId(topic.label);
    state.topics.set(id, buildTopic({ id, label: topic.label, keywords: topic.keywords }));
    added++;
  }

  saveTopics();
  indexPapers();
  render();
  const skipped = valid.length - added;
  el("topics-status").textContent =
    `Imported ${added} topic${added === 1 ? "" : "s"}` + (skipped ? `, ${skipped} already here.` : ".");
}

/* ---------- URL state, so a filtered view can be shared ---------- */

function syncUrl() {
  const params = new URLSearchParams();
  params.set("days", state.days);
  if (state.selected.size) params.set("topics", [...state.selected].join(","));
  if (state.mode !== "any") params.set("mode", state.mode);
  if (state.query) params.set("q", state.query);
  history.replaceState(null, "", `?${params}`);
}

function restoreFromUrl() {
  const params = new URLSearchParams(location.search);
  const days = Number(params.get("days"));
  if ([1, 7, 30].includes(days)) state.days = days;
  for (const id of (params.get("topics") || "").split(",")) {
    if (state.topics.has(id)) state.selected.add(id);
  }
  if (params.get("mode") === "all") state.mode = "all";
  state.query = params.get("q") || "";

  el("query").value = state.query;
  for (const button of el("window-select").children) {
    button.classList.toggle("active", Number(button.dataset.days) === state.days);
  }
  for (const button of el("match-mode").children) {
    button.classList.toggle("active", button.dataset.mode === state.mode);
  }
}

/* ---------- events ---------- */

function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

function wireEvents() {
  el("window-select").addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    state.days = Number(button.dataset.days);
    state.page = 1;
    for (const sibling of el("window-select").children) {
      sibling.classList.toggle("active", sibling === button);
    }
    render();
  });

  el("match-mode").addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    state.mode = button.dataset.mode;
    state.page = 1;
    for (const sibling of el("match-mode").children) {
      sibling.classList.toggle("active", sibling === button);
    }
    render();
  });

  el("topics").addEventListener("change", (event) => {
    const box = event.target;
    if (box.type !== "checkbox") return;
    box.checked ? state.selected.add(box.value) : state.selected.delete(box.value);
    state.page = 1;
    render();
  });

  el("topics").addEventListener("click", (event) => {
    const action = event.target.closest(".row-action");
    if (!action) return;
    const id = action.dataset.topic;
    const topic = state.topics.get(id);
    if (action.classList.contains("edit")) return openForm(id);

    // A topic is a minute of typing to get right, and the button sits a few
    // pixels from the checkbox, so deleting one asks first.
    if (!confirm(`Delete the topic “${topic.label}”?`)) return;
    state.topics.delete(id);
    state.selected.delete(id);
    for (const hits of state.matches.values()) hits.delete(id);
    if (state.editing === id) closeForm();
    saveTopics();
    state.page = 1;
    render();
  });

  el("topic-new").addEventListener("click", () => openForm(null));
  el("topic-cancel").addEventListener("click", closeForm);
  el("topic-keywords").addEventListener("input", debounce(previewTopic, 200));

  el("topic-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const label = el("topic-label").value.trim();
    const keywords = parseKeywords(el("topic-keywords").value);
    if (!label || !keywords.length) return;

    // Map.set on an existing key keeps its position, so editing a topic does
    // not send it to the bottom of the list.
    const id = state.editing || topicId(label);
    state.topics.set(id, buildTopic({ id, label, keywords }));
    // A topic you just defined is one you want to see: select it, so saving
    // shows the papers instead of just a new line in the sidebar.
    if (!state.editing) state.selected.add(id);

    saveTopics();
    indexPapers();
    closeForm();
    state.page = 1;
    render();
  });

  el("topics-export").addEventListener("click", exportTopics);
  el("topics-import").addEventListener("click", () => el("topics-file").click());
  el("topics-file").addEventListener("change", (event) => {
    const [file] = event.target.files;
    if (file) importTopics(file);
    event.target.value = "";   // so picking the same file twice fires again
  });

  el("active-filters").addEventListener("click", (event) => {
    const chip = event.target.closest(".chip");
    if (!chip) return;
    state.selected.delete(chip.dataset.topic);
    state.page = 1;
    render();
  });

  el("clear-topics").addEventListener("click", () => {
    state.selected.clear();
    state.page = 1;
    render();
  });

  el("query").addEventListener("input", debounce((event) => {
    state.query = event.target.value;
    state.page = 1;
    render();
  }, 200));

  el("pager").addEventListener("click", (event) => {
    if (event.target.id === "prev") state.page -= 1;
    else if (event.target.id === "next") state.page += 1;
    else return;
    render();
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  el("theme-toggle").addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("theme", next);
  });
}

/* ---------- boot ---------- */

function showFailure(heading, body, error) {
  el("result-count").textContent = heading;
  el("papers").innerHTML = `<p class="empty-state">${body}</p>`;
  console.error(error);
}

async function main() {
  document.documentElement.dataset.theme =
    localStorage.getItem("theme") ||
    (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");

  let payload;
  try {
    const papersResponse = await fetch("data/papers.json");
    if (!papersResponse.ok) throw new Error("fetch failed");
    payload = await papersResponse.json();
  } catch (error) {
    return showFailure("Could not load the data",
      `Unable to read <code>data/papers.json</code>.<br>
       If you opened the file locally, serve the folder with
       <code>python3 -m http.server</code> instead.`, error);
  }

  // Kept apart from the fetch above: a crash in here is a bug or a stale
  // cached script, and blaming the data file would send you hunting in the
  // wrong place — as it did when a cached app.js met a newer index.html.
  try {
    state.papers = payload.papers;
    state.newest = new Date(payload.papers[0].published);

    loadTopics();
    indexPapers();

    const generated = new Date(payload.generated_at);
    el("freshness").textContent =
      `${payload.count} papers · updated ${formatDate(payload.generated_at)} ${generated.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
    el("window-hint").textContent =
      `Measured from the latest submission (${formatDate(payload.papers[0].published)}), not from the current time.`;

    restoreFromUrl();
    wireEvents();
    render();
  } catch (error) {
    return showFailure("Something went wrong displaying the data",
      `The data loaded, but the page failed to render it.<br>
       Try a hard refresh (<code>Ctrl/Cmd + Shift + R</code>) to clear a stale script.`, error);
  }

  // The group panel is a bonus: a missing or broken group.json must not take
  // the rest of the page down with it.
  try {
    const groupResponse = await fetch("data/group.json");
    if (!groupResponse.ok) throw new Error("no group data");
    renderGroup(await groupResponse.json());
  } catch (groupError) {
    document.querySelector(".group-panel")?.remove();
    console.warn("group panel unavailable:", groupError);
  }
}

main();
