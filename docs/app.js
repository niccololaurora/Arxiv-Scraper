/* quant-ph topic scanner — static client, no build step, no dependencies. */

const PAGE = 25;              // papers added per scroll
const TOPICS_KEY = "my-topics";
const AUTHORS_KEY = "followed-authors";
const SCORE_KEY = "min-score";

/** The three sections of an arXiv listing, carried in the data as
 *  announce_type rather than guessed from the metadata. Guessing was wrong in
 *  both directions: a paper held by moderation is announced days after it was
 *  submitted, and a paper posted one day and revised the next is announced
 *  twice — once in each section. */
const KINDS = [
  { id: "new", label: "New", title: "Announced as a new quant-ph submission" },
  { id: "cross", label: "Cross-lists", title: "Announced as a cross-list from another archive" },
  { id: "replace", label: "Replacements", title: "Announced as a revision of an earlier paper" },
];

const paperKind = (paper) => paper.announce_type;

const state = {
  papers: [],
  topics: new Map(),      // id -> {id, label, keywords, regex} — all of them the reader's own
  matches: new Map(),     // paper id -> Set of topic ids
  allListings: [],        // every announcement day in the dataset, newest first
  listings: 1,            // how many of them the window covers
  selected: new Set(),
  kinds: new Set(KINDS.map((kind) => kind.id)),
  editing: null,          // topic id the form is editing, null when it creates a new one
  mode: "any",
  query: "",
  shown: PAGE,            // how far down the infinite scroll has got
  authors: [],            // names the reader follows, as typed
  groupPapers: [],        // the group's own recent submissions, for the right-hand panel
  sort: "listing",        // or "mine", once a Zotero profile exists
  profile: null,          // weighted terms derived from the reader's library
  tags: [],               // the library's own tags, with their item counts
  corpus: null,           // document frequencies over our own papers, built once
  scores: new Map(),      // paper id -> {score, because}
  minScore: 0,            // hide anything below this many percent
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

/** The announcement days the window covers, newest first. The scraper records
 *  which listing each paper appeared in, so this is a lookup rather than a
 *  date calculation — no cut-off times, no weekends, no daylight saving. */
const windowDays = () => new Set(state.allListings.slice(0, state.listings));

/* ---------- Zotero: how close a paper is to what you already read ---------- */

/** Scoring every paper against the profile costs a pass over the corpus, so
 *  it happens once per profile and is then a lookup. */
function rescore() {
  state.scores = new Map();
  if (!state.profile) return;
  state.corpus = state.corpus || Zotero.documentFrequencies(state.papers);
  for (const paper of state.papers) {
    if (!state.scores.has(paper.id)) {
      state.scores.set(paper.id, Zotero.score(paper, state.profile, state.corpus));
    }
  }
}

const scoreOf = (paper) => state.scores.get(paper.id)?.score || 0;

/** Scores live on their own scale: a library of one subject reaches 25%, a
 *  scattered one may never pass 8%. The slider therefore ends at the best
 *  score there is, so the whole of its travel does something. */
const bestScore = () =>
  // Rounded down, not up: at the end of its travel the slider should leave
  // the best paper standing rather than cut it by a fraction of a percent.
  Math.floor(100 * Math.max(0, ...[...state.scores.values()].map((match) => match.score)));

const aboveThreshold = (paper) =>
  !state.minScore || !state.profile || scoreOf(paper) * 100 >= state.minScore;

/** state.papers arrives in arXiv's own listing order — newest listing first,
 *  then new, cross-lists and replacements, each by ascending id — so filtering
 *  preserves it and nothing needs re-sorting. */
function currentResults() {
  const days = windowDays();
  const terms = parseQuery(state.query);
  const selected = [...state.selected];

  const kept = state.papers.filter((paper) => {
    if (!days.has(paper.announced)) return false;
    if (!state.kinds.has(paperKind(paper))) return false;
    if (!aboveThreshold(paper)) return false;
    if (!matchesQuery(paper, terms)) return false;
    if (!selected.length) return true;
    const hits = state.matches.get(paper.id);
    return state.mode === "all"
      ? selected.every((id) => hits.has(id))
      : selected.some((id) => hits.has(id));
  });

  // Sorting by closeness is a different question from "what came out today",
  // so it reorders the window rather than replacing it.
  return state.sort === "mine" && state.profile
    ? [...kept].sort((one, other) => scoreOf(other) - scoreOf(one))
    : kept;
}

/** Per-topic counts within the current time window, ignoring topic selection. */
function topicCounts() {
  const days = windowDays();
  const terms = parseQuery(state.query);
  const counts = new Map();
  for (const paper of state.papers) {
    if (!days.has(paper.announced)) continue;
    if (!state.kinds.has(paperKind(paper))) continue;
    if (!aboveThreshold(paper)) continue;
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
  const days = windowDays();
  const terms = parseQuery(state.query);
  const selected = [...state.selected];
  const counts = new Map();

  for (const paper of state.papers) {
    if (!days.has(paper.announced)) continue;
    if (!aboveThreshold(paper)) continue;
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
  const days = windowDays();
  const inWindow = state.papers.filter((paper) => days.has(paper.announced));
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

/** The terms a paper shares with your library. A ranking you cannot argue
 *  with is a ranking you cannot trust, so the reason travels with the score. */
function renderWhy(paper) {
  if (!state.profile) return "";
  const match = state.scores.get(paper.id);
  if (!match || match.score < 0.02) return "";
  return `<p class="why">
    <span class="why-score">${Math.floor(match.score * 100)}%</span>
    like your library — ${match.because
      .map((term) => escapeHtml(state.profile.words?.[term] || term)).join(" · ")}
  </p>`;
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
      // A replacement is dated by its revision: a 2024 paper re-announced this
      // morning reading "2024" in a feed of today's listing is a riddle.
      const shown = paper.announce_type === "replace" ? paper.updated : paper.published;
      return `<article class="paper">
        <div class="paper-meta">
          <time>${formatDate(shown)}</time>
          ${paper.version > 1 ? `<span class="tag">v${paper.version}</span>` : ""}
          ${crossLists.length ? `<span class="tag">${escapeHtml(crossLists.join(" · "))}</span>` : ""}
          <span class="arxiv-id">${escapeHtml(paper.id)}</span>
        </div>
        <h3><a href="${paper.abs_url}" target="_blank" rel="noopener">${highlight(paper.title, terms)}</a></h3>
        <p class="authors">${escapeHtml(formatAuthors(paper.authors))}</p>
        ${hits ? `<div class="badges">${hits}</div>` : ""}
        ${renderWhy(paper)}
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
        : `<li class="group-empty">Nothing in these ${state.allListings.length} listings.</li>`;
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
  const above = state.minScore && state.profile ? ` at ${state.minScore}% or more like your library` : "";
  el("result-count").textContent = `${results.length} ${noun} ${window}${filtered}${above}`;
  const days = [...windowDays()];
  el("window-hint").textContent = days.length === 1
    ? `arXiv's quant-ph listing for ${formatDate(days[0])}.`
    : `The ${days.length} arXiv listings from ${formatDate(days.at(-1))} to ${formatDate(days[0])}.`;
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

/* ---------- the Zotero panel ---------- */

/** The terms worth showing: spelled the way you write them, and with a word
 *  dropped when a pair already on display contains it — "bosonic" next to
 *  "bosonic codes" is one idea taking two places. */
function profileWords(limit) {
  // Weight decides, and whatever is taken suppresses the terms that merely
  // repeat it: "bosonic" and "bosonic codes" are one idea in two places.
  // Checking against the whole list instead of against what is already shown
  // threw away "squeezing" itself, for a pair three hundred places below it.
  const shown = [];
  for (const term of Object.keys(state.profile.terms)) {
    const repeats = shown.some((taken) =>
      taken.split(" ").includes(term) || term.split(" ").includes(taken));
    if (!repeats) shown.push(term);
    if (shown.length === limit) break;
  }
  return shown.map((term) => state.profile.words?.[term] || term);
}

function renderScope() {
  const account = Zotero.loadAccount();
  el("zotero-scope").hidden = !state.profile || !state.tags.length;
  if (el("zotero-scope").hidden) return;
  el("zotero-tag").innerHTML = [{ tag: "", items: 0 }, ...state.tags]
    .map(({ tag, items }) => {
      const label = tag ? `${tag} (${items})` : "the whole library";
      const chosen = (account?.tag || "") === tag ? "selected" : "";
      return `<option value="${escapeHtml(tag)}" ${chosen}>${escapeHtml(label)}</option>`;
    })
    .join("");
}

function renderZotero() {
  const account = Zotero.loadAccount();
  el("zotero-form").hidden = Boolean(state.profile);
  el("zotero-forget").hidden = !state.profile;
  el("scored").hidden = !state.profile;
  if (state.profile) {
    const best = Math.max(bestScore(), 1);
    el("min-score").max = best;
    state.minScore = Math.min(state.minScore, best);
    el("min-score").value = state.minScore;
    el("min-score-value").textContent = `${state.minScore}%`;
  }
  renderScope();
  el("zotero-profile").innerHTML = state.profile
    ? `<p class="hint">
         ${state.profile.withText} of ${state.profile.items} items had a title or abstract to read.
         Built ${formatDate(state.profile.at)}.
       </p>
       <div class="badges">${profileWords(8)
         .map((word) => `<span class="badge">${escapeHtml(word)}</span>`).join("")}</div>
       <div class="panel-foot"><button id="zotero-refresh" class="link-button">read it again</button></div>`
    : "";
}

async function connectZotero(account) {
  const say = (text) => { el("zotero-status").textContent = text; };
  try {
    say("Checking the key…");
    account = account.userId ? account : await Zotero.identify(account.key);
    const what = account.tag ? `everything tagged “${account.tag}”` : "your library";
    say(`Reading ${what}…`);
    const [items, tags] = await Promise.all([
      Zotero.fetchLibrary(account, (done, total) => say(`Reading ${what} — ${done} of ${total}…`)),
      state.tags.length ? Promise.resolve(state.tags) : Zotero.fetchTags(account),
    ]);
    state.tags = tags;
    if (!items.length) return say(`Nothing is tagged “${account.tag}”.`);

    state.corpus = state.corpus || Zotero.documentFrequencies(state.papers);
    state.profile = Zotero.buildProfile(items, state.corpus);
    if (!state.profile.withText) {
      state.profile = null;
      return say("None of those items had a title or abstract to learn from.");
    }
    Zotero.saveAccount(account);
    Zotero.saveProfile(state.profile);
    rescore();
    say("");
    renderZotero();
    refilter();
  } catch (error) {
    say(error.message);
    console.error(error);
  }
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

  el("zotero-form").addEventListener("submit", (event) => {
    event.preventDefault();
    connectZotero({ key: el("zotero-key").value.trim() });
  });

  el("zotero-tag").addEventListener("change", (event) => {
    const account = Zotero.loadAccount();
    if (account) connectZotero({ ...account, tag: event.target.value });
  });

  el("zotero-forget").addEventListener("click", () => {
    // The key goes with the profile: keeping credentials for a connection the
    // reader has just undone would be a nasty surprise.
    Zotero.saveAccount(null);
    Zotero.saveProfile(null);
    state.profile = null;
    state.scores = new Map();
    state.sort = "listing";
    el("zotero-key").value = "";
    el("zotero-status").textContent = "";
    renderZotero();
    refilter();
  });

  el("zotero-profile").addEventListener("click", (event) => {
    if (event.target.id !== "zotero-refresh") return;
    const account = Zotero.loadAccount();
    if (account) connectZotero(account);
  });

  el("min-score").addEventListener("input", (event) => {
    state.minScore = Number(event.target.value);
    el("min-score-value").textContent = `${state.minScore}%`;
    localStorage.setItem(SCORE_KEY, state.minScore);
    refilter();
  });

  el("sort-order").addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    state.sort = button.dataset.sort;
    for (const sibling of el("sort-order").children) {
      sibling.classList.toggle("active", sibling === button);
    }
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
      ? `${found} paper${found === 1 ? "" : "s"} by ${name} in the last ${state.allListings.length} listings.`
      : `Nothing by ${name} in the last ${state.allListings.length} listings — new ones will show up here.`;
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
    state.allListings = payload.listings;

    loadTopics();
    loadAuthors();
    indexPapers();

    const generated = new Date(payload.generated_at);
    el("freshness").textContent =
      `${payload.count} papers · updated ${formatDate(payload.generated_at)} ${generated.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;

    state.profile = Zotero.loadProfile();
    state.minScore = Number(localStorage.getItem(SCORE_KEY)) || 0;
    rescore();
    // An older profile was dropped by loadProfile; rebuild it rather than
    // leave the panel looking disconnected for no reason the reader can see.
    if (!state.profile && Zotero.loadAccount()) connectZotero(Zotero.loadAccount());

    restoreFromUrl();
    wireEvents();
    renderZotero();
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
