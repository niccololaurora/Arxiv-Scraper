/* quant-ph topic scanner — static client, no build step, no dependencies. */

const PAGE = 25;              // papers added per scroll
const TOPICS_KEY = "my-topics";
const AUTHORS_KEY = "followed-authors";

/** arXiv announces a day's quant-ph in three lists, and these reproduce them as
 *  a partition of the data — every paper lands in exactly one.
 *  "Replacement" is narrower here than on arXiv: the API's date filters only
 *  ever match the v1 submission date, so a paper submitted last year and
 *  revised today is not in the dataset at all. What we can see is a paper
 *  submitted inside the window that has since gained a version. */
const KINDS = [
  { id: "new", label: "New", title: "First version, submitted to quant-ph" },
  { id: "cross", label: "Cross-lists", title: "Submitted to another archive, cross-listed to quant-ph" },
  { id: "replace", label: "Replacements", title: "Revised since it was first submitted (v2 or later)" },
];

const paperKind = (paper) =>
  paper.version > 1 ? "replace" : paper.primary_category === "quant-ph" ? "new" : "cross";

const state = {
  papers: [],
  topics: new Map(),      // id -> {id, label, keywords, regex} — all of them the reader's own
  matches: new Map(),     // paper id -> Set of topic ids
  newest: null,           // most recent submission in the dataset
  listings: 1,            // how many arXiv announcements back the window reaches
  selected: new Set(),
  kinds: new Set(KINDS.map((kind) => kind.id)),
  editing: null,          // topic id the form is editing, null when it creates a new one
  mode: "any",
  query: "",
  shown: PAGE,            // how far down the infinite scroll has got
  authors: [],            // names the reader follows, as typed
  groupPapers: [],        // the group's own recent submissions, for the right-hand panel
  windowDays: 0,          // how far back the dataset itself goes
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

/** arXiv does not announce continuously. Everything submitted between two
 *  14:00 ET cut-offs is announced together, and there is no cut-off at the
 *  weekend — so Tuesday's listing carries Friday, Saturday, Sunday and Monday
 *  in one go. A literal 24h window showed 70 of those 148 papers and dated
 *  them three days back, which reads as a stale site rather than as what it
 *  was: one listing, sliced.
 *
 *  The cut-offs are counted back from the newest submission rather than from
 *  a wall clock, so nothing here needs to know about daylight saving or about
 *  what time it is where the reader sits. */
function cutoff() {
  let instant = state.newest.getTime();
  for (let listings = 0; listings < state.listings; ) {
    instant -= 86400000;
    const weekday = new Date(instant).getUTCDay();
    if (weekday !== 0 && weekday !== 6) listings++;   // no cut-off at the weekend
  }
  return new Date(instant);
}

/** state.papers arrives newest-first from the scraper, so filtering preserves
 *  the chronological order and nothing needs re-sorting. */
function currentResults() {
  const since = cutoff();
  const terms = parseQuery(state.query);
  const selected = [...state.selected];

  return state.papers.filter((paper) => {
    if (new Date(paper.published) < since) return false;
    if (!state.kinds.has(paperKind(paper))) return false;
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
    if (!state.kinds.has(paperKind(paper))) continue;
    if (!matchesQuery(paper, terms)) continue;
    for (const id of state.matches.get(paper.id)) {
      counts.set(id, (counts.get(id) || 0) + 1);
    }
  }
  return counts;
}

/** Per-kind counts, ignoring which kinds are switched on: a button has to be
 *  able to say what it would bring back. */
function kindCounts() {
  const since = cutoff();
  const terms = parseQuery(state.query);
  const selected = [...state.selected];
  const counts = new Map();

  for (const paper of state.papers) {
    if (new Date(paper.published) < since) continue;
    if (!matchesQuery(paper, terms)) continue;
    if (selected.length) {
      const hits = state.matches.get(paper.id);
      const keep = state.mode === "all"
        ? selected.every((id) => hits.has(id))
        : selected.some((id) => hits.has(id));
      if (!keep) continue;
    }
    const kind = paperKind(paper);
    counts.set(kind, (counts.get(kind) || 0) + 1);
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

function renderKinds() {
  const counts = kindCounts();
  el("kind-filter").innerHTML = KINDS
    .map((kind) => {
      const on = state.kinds.has(kind.id);
      return `<button class="kind ${on ? "on" : ""}" data-kind="${kind.id}"
        aria-pressed="${on}" title="${kind.title}"
      >${kind.label} <span class="count">${counts.get(kind.id) || 0}</span></button>`;
    })
    .join("");
}

function renderPapers(results) {
  const terms = parseQuery(state.query);
  if (!results.length) {
    el("papers").innerHTML = `<p class="empty-state">
      No paper matches these filters in this time window.<br>
      Try a wider window, or drop one of the topics.
    </p>`;
    el("pager").textContent = "";
    return;
  }
  el("papers").innerHTML = paperList(results.slice(0, state.shown), terms);
  renderPager(results);
}

function paperList(papers, terms) {
  return papers
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
}

function renderPager(results) {
  const shown = Math.min(state.shown, results.length);
  el("pager").textContent = shown < results.length
    ? `${shown} of ${results.length} — keep scrolling`
    : `all ${results.length} shown`;
}

/** Appending the next batch instead of redrawing the list keeps the cost of a
 *  scroll proportional to the batch: jumping to the bottom of 2000 results
 *  otherwise re-rendered everything already on screen, once per batch. */
function growPapers(results) {
  const from = state.shown;
  state.shown += PAGE;
  el("papers").insertAdjacentHTML(
    "beforeend", paperList(results.slice(from, state.shown), parseQuery(state.query))
  );
  renderPager(results);
}

/** Grow the list when the sentinel below it comes into view. rootMargin starts
 *  the next batch a screenful early, so the scroll never actually stops. */
function watchSentinel() {
  const sentinel = el("sentinel");
  const observer = new IntersectionObserver((entries) => {
    if (!entries.some((entry) => entry.isIntersecting)) return;
    const results = currentResults();
    if (state.shown >= results.length) return;
    growPapers(results);
    // An observer only reports transitions, and the sentinel can stay in view
    // after a batch lands — on a short list, or with the group panel below it
    // on a narrow screen. Re-observing asks for a fresh verdict, so the list
    // keeps growing until the sentinel is genuinely out of reach.
    observer.unobserve(sentinel);
    observer.observe(sentinel);
  }, { rootMargin: "800px" });
  observer.observe(sentinel);
}

/* ---------- followed authors ---------- */

const stripAccents = (text) =>
  text.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

/** "Matteo G. A. Paris" -> ["matteo", "paris"] */
function nameParts(name) {
  const tokens = stripAccents(name).replace(/\./g, " ").split(/\s+/).filter(Boolean);
  return tokens.length > 1 ? [tokens[0], tokens.at(-1)] : ["", tokens[0] || ""];
}

/** The surname must agree, and the first name too when you gave one — without
 *  that, following a Gupta or a Sharma returns a stranger's papers. An initial
 *  counts as the first name, since "M. Genoni" is the same person as "Marco
 *  Genoni". A bare surname is accepted: it is what you want for a rare name,
 *  and your problem if it is not. */
function authorMatches(author, [wantFirst, wantLast]) {
  const [first, last] = nameParts(author);
  if (last !== wantLast) return false;
  if (!wantFirst || !first) return true;
  return first === wantFirst || first[0] === wantFirst[0] && (first.length === 1 || wantFirst.length === 1);
}

/** Papers by one followed author. group.json is searched too: it reaches
 *  outside quant-ph, so for a group member it can hold papers papers.json
 *  never saw. */
function papersBy(name) {
  const wanted = nameParts(name);
  const seen = new Set();
  return [...state.papers, ...state.groupPapers]
    .filter((paper) => {
      if (seen.has(paper.id) || !paper.authors.some((author) => authorMatches(author, wanted))) return false;
      seen.add(paper.id);
      return true;
    })
    .sort((a, b) => (a.published < b.published ? 1 : -1));
}

function loadAuthors() {
  try {
    const stored = JSON.parse(localStorage.getItem(AUTHORS_KEY) || "[]");
    if (Array.isArray(stored)) state.authors = stored.filter((name) => typeof name === "string");
  } catch (error) {
    console.warn("could not read your authors:", error);
  }
}

function saveAuthors() {
  try {
    localStorage.setItem(AUTHORS_KEY, JSON.stringify(state.authors));
  } catch (error) {
    console.warn("could not save your authors:", error);
  }
}

/** Independent of the filters on the left, like the group panel, so it is only
 *  redrawn when the list itself changes — scanning every author of every paper
 *  is too much work to repeat on each keystroke in the search box. */
function renderAuthors() {
  el("followed").innerHTML = state.authors
    .map((name) => {
      const papers = papersBy(name);
      const items = papers.length
        ? papers.map((paper) => `<li class="group-item">
            <time>${formatDate(paper.published)}</time>
            <a href="${paper.abs_url}" target="_blank" rel="noopener">${escapeHtml(paper.title)}</a>
          </li>`).join("")
        : `<li class="group-empty">Nothing in the last ${state.windowDays} days.</li>`;
      return `<div class="author">
        <div class="author-head">
          <span class="author-name">${escapeHtml(name)}</span>
          <span class="count">${papers.length}</span>
          <button class="row-action unfollow" data-author="${escapeHtml(name)}"
            title="Stop following ${escapeHtml(name)}">×</button>
        </div>
        <ol class="group-list">${items}</ol>
      </div>`;
    })
    .join("");
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
  const window = { 1: "in the latest listing", 5: "in the last week", 20: "in the last month" }[state.listings];
  const noun = results.length === 1 ? "paper" : "papers";
  const filtered = state.selected.size || state.query ? " matching your filters" : "";
  el("result-count").textContent = `${results.length} ${noun} ${window}${filtered}`;
  el("window-hint").textContent =
    `arXiv announces in batches, so this is counted in listings rather than in hours: ` +
    `submissions from ${formatDate(cutoff())} to ${formatDate(state.newest)}.`;
  renderKinds();
  renderTopics();
  renderActiveFilters();
  renderPapers(results);
  syncUrl();
}

/** Every filter change starts the list from the top again. */
function refilter() {
  state.shown = PAGE;
  render();
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
  params.set("lists", state.listings);
  if (state.selected.size) params.set("topics", [...state.selected].join(","));
  if (state.mode !== "any") params.set("mode", state.mode);
  if (state.query) params.set("q", state.query);
  if (state.kinds.size < KINDS.length) params.set("kinds", [...state.kinds].join(","));
  history.replaceState(null, "", `?${params}`);
}

function restoreFromUrl() {
  const params = new URLSearchParams(location.search);
  // Links shared before the window counted listings carried days=1|7|30.
  const legacy = { 1: 1, 7: 5, 30: 20 }[Number(params.get("days"))];
  const listings = Number(params.get("lists")) || legacy;
  if ([1, 5, 20].includes(listings)) state.listings = listings;
  for (const id of (params.get("topics") || "").split(",")) {
    if (state.topics.has(id)) state.selected.add(id);
  }
  if (params.get("mode") === "all") state.mode = "all";
  state.query = params.get("q") || "";

  const kinds = (params.get("kinds") || "").split(",").filter((kind) => state.kinds.has(kind));
  if (kinds.length) state.kinds = new Set(kinds);

  el("query").value = state.query;
  for (const button of el("window-select").children) {
    button.classList.toggle("active", Number(button.dataset.listings) === state.listings);
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
    state.listings = Number(button.dataset.listings);
    for (const sibling of el("window-select").children) {
      sibling.classList.toggle("active", sibling === button);
    }
    refilter();
  });

  el("match-mode").addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    state.mode = button.dataset.mode;
    for (const sibling of el("match-mode").children) {
      sibling.classList.toggle("active", sibling === button);
    }
    refilter();
  });

  el("topics").addEventListener("change", (event) => {
    const box = event.target;
    if (box.type !== "checkbox") return;
    box.checked ? state.selected.add(box.value) : state.selected.delete(box.value);
    refilter();
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
    refilter();
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
    refilter();
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
    refilter();
  });

  el("clear-topics").addEventListener("click", () => {
    state.selected.clear();
    refilter();
  });

  el("query").addEventListener("input", debounce((event) => {
    state.query = event.target.value;
    refilter();
  }, 200));

  el("kind-filter").addEventListener("click", (event) => {
    const button = event.target.closest(".kind");
    if (!button) return;
    const kind = button.dataset.kind;
    // Turning the last one off would leave an empty page with no way back, so
    // the final kind stays on and clicking it is a no-op.
    if (state.kinds.has(kind)) {
      if (state.kinds.size === 1) return;
      state.kinds.delete(kind);
    } else {
      state.kinds.add(kind);
    }
    refilter();
  });

  el("author-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const name = el("author-name").value.trim();
    if (!name) return;
    if (state.authors.some((followed) => followed.toLowerCase() === name.toLowerCase())) {
      el("author-hint").textContent = `You already follow ${name}.`;
      return;
    }
    state.authors.push(name);
    saveAuthors();
    renderAuthors();
    el("author-name").value = "";
    const found = papersBy(name).length;
    // Zero is not a failure: the name is kept, and the next paper by that
    // author appears here on its own.
    el("author-hint").textContent = found
      ? `${found} paper${found === 1 ? "" : "s"} by ${name} in the last ${state.windowDays} days.`
      : `Nothing by ${name} in the last ${state.windowDays} days — new ones will show up here.`;
  });

  el("followed").addEventListener("click", (event) => {
    const button = event.target.closest(".unfollow");
    if (!button) return;
    state.authors = state.authors.filter((name) => name !== button.dataset.author);
    saveAuthors();
    renderAuthors();
    el("author-hint").textContent = "";
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
    state.windowDays = payload.window_days;

    loadTopics();
    loadAuthors();
    indexPapers();

    const generated = new Date(payload.generated_at);
    el("freshness").textContent =
      `${payload.count} papers · updated ${formatDate(payload.generated_at)} ${generated.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;

    restoreFromUrl();
    wireEvents();
    watchSentinel();
    render();
    renderAuthors();
  } catch (error) {
    return showFailure("Something went wrong displaying the data",
      `The data loaded, but the page failed to render it.<br>
       Try a hard refresh (<code>Ctrl/Cmd + Shift + R</code>) to clear a stale script.`, error);
  }

  // The group list is a bonus: a missing or broken group.json must not take
  // the rest of the page down with it. The followed authors live in the same
  // column but do not depend on it, so only the group section is removed.
  try {
    const groupResponse = await fetch("data/group.json");
    if (!groupResponse.ok) throw new Error("no group data");
    const group = await groupResponse.json();
    state.groupPapers = group.papers;
    renderGroup(group);
    renderAuthors();   // group.json can hold papers papers.json does not
  } catch (groupError) {
    el("group-details")?.closest(".panel").remove();
    console.warn("group panel unavailable:", groupError);
  }
}

main();
