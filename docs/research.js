/* Research — asks OpenAlex how connected your topics are. No build step. */

const OPENALEX = "https://api.openalex.org/works";
const TOPICS_KEY = "my-topics";          // written by the Scanner
const CACHE_KEY = "research-probe";
const RECENT_SINCE = new Date().getFullYear() - 4;
const CONCURRENCY = 4;                   // OpenAlex asks for no more than 10 req/s

const el = (id) => document.getElementById(id);

const escapeHtml = (text) =>
  String(text).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char]));

const formatNumber = (value) => value.toLocaleString("en-GB");

/* ---------- OpenAlex ---------- */

/** Every keyword is quoted, because an unquoted phrase is matched word by
 *  word: "phase space" unquoted returns 338k papers — every paper with either
 *  word anywhere — against 64k for the phrase itself. Single words are
 *  unaffected by the quotes, so they get them too rather than a special case.
 *
 *  Commas separate filters, pipes separate OR-ed values and quotes delimit the
 *  phrase, so all three are stripped out of the keyword first. */
const searchFilter = (keywords) =>
  "title_and_abstract.search:" + keywords
    .map((keyword) => keyword.replace(/["|,]/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .map((keyword) => encodeURIComponent(`"${keyword}"`))
    .join("|");

/** The background narrows every count to one literature. Without it the
 *  denominator is all of science, where two quantum subjects co-occur far
 *  above chance for the single reason that both are quantum: entanglement and
 *  error correction score 190x against everything, and a telling 3x against
 *  quantum papers alone. */
const background = () => {
  const text = el("background").value.replace(/["|,]/g, " ").trim();
  return text ? [`title_and_abstract.search:${encodeURIComponent(`"${text}"`)}`] : [];
};

/** has_abstract is in every query: a title-and-abstract search can only ever
 *  match a paper that has one, so it is also the right denominator. */
async function openalex(filters, extra = "") {
  const all = [...background(), ...filters, "has_abstract:true"];
  // per_page caps the number of *groups* as well as the number of works, so
  // asking for one result alongside group_by silently returns a histogram with
  // a single bar — the year 2026 standing in for the whole decade.
  const perPage = extra.includes("group_by") ? 200 : 1;
  const response = await fetch(`${OPENALEX}?filter=${all.join(",")}${extra}&per_page=${perPage}`);
  if (!response.ok) throw new Error(`OpenAlex answered ${response.status}`);
  return response.json();
}

/** One call gives both the total and the year histogram. */
async function countByYear(filters) {
  const data = await openalex(filters, "&group_by=publication_year");
  const years = new Map(data.group_by.map((group) => [Number(group.key), group.count]));
  let recent = 0;
  for (const [year, count] of years) if (year >= RECENT_SINCE) recent += count;
  return { total: data.meta.count, recent, years };
}

/** Run the tasks a few at a time rather than firing 50 requests at once. */
async function pool(tasks, onProgress) {
  const results = new Array(tasks.length);
  let next = 0, done = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, async () => {
    while (next < tasks.length) {
      const index = next++;
      try {
        results[index] = await tasks[index]();
      } catch (error) {
        results[index] = { error: error.message };
      }
      onProgress(++done, tasks.length);
    }
  }));
  return results;
}

/* ---------- the probe ---------- */

function loadTopics() {
  try {
    const stored = JSON.parse(localStorage.getItem(TOPICS_KEY) || "[]");
    return Array.isArray(stored)
      ? stored.filter((topic) => topic && topic.label && Array.isArray(topic.keywords) && topic.keywords.length)
      : [];
  } catch (error) {
    console.warn("could not read your topics:", error);
    return [];
  }
}

async function probe(topics) {
  const say = (text) => { el("status").textContent = text; };

  const corpus = (await openalex([])).meta.count;

  const measured = await pool(
    topics.map((topic) => async () => {
      const counts = await countByYear([searchFilter(topic.keywords)]);
      const areas = await openalex([searchFilter(topic.keywords)], "&group_by=topics.id");
      return { ...topic, ...counts, areas: areas.group_by.slice(0, 5) };
    }),
    (done, total) => say(`Measuring your topics — ${done} of ${total}…`)
  );

  const ok = measured.filter((topic) => !topic.error);
  const combinations = [];
  for (let i = 0; i < ok.length; i++) {
    for (let j = i + 1; j < ok.length; j++) combinations.push([ok[i], ok[j]]);
  }

  const pairs = await pool(
    combinations.map(([a, b]) => async () => {
      const counts = await countByYear([searchFilter(a.keywords), searchFilter(b.keywords)]);
      // What you would see if the two subjects were spread independently
      // across the corpus. Below 1 means the literature keeps them apart.
      const expected = (a.total * b.total) / corpus;
      return { a, b, ...counts, expected, lift: expected ? counts.total / expected : 0 };
    }),
    (done, total) => say(`Pairing them up — ${done} of ${total}…`)
  );

  say("");
  return {
    corpus, topics: measured, background: el("background").value.trim(),
    pairs: pairs.filter((pair) => !pair.error), at: new Date().toISOString(),
  };
}

/* ---------- rendering ---------- */

const arxivSearch = (...topics) =>
  "https://arxiv.org/search/?searchtype=all&query=" +
  encodeURIComponent(topics.map((topic) => topic.keywords[0]).join(" "));

/** A 10-year bar strip. Shape is the point, so it is scaled to its own peak. */
function sparkline(years) {
  const span = [];
  for (let year = RECENT_SINCE - 5; year <= RECENT_SINCE + 4; year++) span.push([year, years.get(year) || 0]);
  const peak = Math.max(...span.map(([, count]) => count), 1);
  return `<span class="spark" title="${span.map(([y, c]) => `${y}: ${c}`).join(", ")}">${
    span.map(([, count]) => `<i style="height:${Math.max(2, Math.round(100 * count / peak))}%"></i>`).join("")
  }</span>`;
}

const verdict = (lift) =>
  lift === 0 ? ["nothing at all", "gap"]
    : lift < 0.5 ? ["under-connected", "gap"]
    : lift < 2 ? ["about as expected", "even"]
    : ["already well linked", "linked"];

function renderTopics(topics) {
  const rows = topics.map((topic) => {
    if (topic.error) {
      return `<tr><td>${escapeHtml(topic.label)}</td><td colspan="4" class="muted">${escapeHtml(topic.error)}</td></tr>`;
    }
    const share = topic.total ? Math.round(100 * topic.recent / topic.total) : 0;
    const areas = topic.areas.map((area) => escapeHtml(area.key_display_name)).join(" · ");
    return `<tr>
      <td><strong>${escapeHtml(topic.label)}</strong></td>
      <td class="num">${formatNumber(topic.total)}</td>
      <td class="num">${share}%</td>
      <td>${sparkline(topic.years)}</td>
      <td class="areas">${areas || "<span class=\"muted\">—</span>"}</td>
    </tr>`;
  }).join("");

  return `<h2>Your topics in the whole literature</h2>
    <div class="table-wrap"><table>
      <thead><tr>
        <th>Topic</th><th class="num">Papers</th>
        <th class="num" title="Share published since ${RECENT_SINCE}">Recent</th>
        <th>${RECENT_SINCE - 5}–${RECENT_SINCE + 4}</th>
        <th>Sits among</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
}

function renderPairs(pairs) {
  if (!pairs.length) {
    return `<p class="empty-state">
      Two topics make one pair, and one pair is not a table.<br>
      Define a few more in the Scanner and come back.
    </p>`;
  }

  const rows = [...pairs].sort((one, other) => one.lift - other.lift).map((pair) => {
    const [label, kind] = verdict(pair.lift);
    const share = pair.total ? Math.round(100 * pair.recent / pair.total) : 0;
    return `<tr>
      <td><strong>${escapeHtml(pair.a.label)}</strong> × <strong>${escapeHtml(pair.b.label)}</strong></td>
      <td class="num">${formatNumber(pair.total)}</td>
      <td class="num muted">${formatNumber(Math.round(pair.expected))}</td>
      <td class="num"><span class="badge ${kind}">${pair.lift.toFixed(2)}× ${label}</span></td>
      <td class="num">${pair.total ? `${share}%` : "—"}</td>
      <td><a href="${arxivSearch(pair.a, pair.b)}" target="_blank" rel="noopener">read</a></td>
    </tr>`;
  }).join("");

  return `<h2>Every pair, thinnest first</h2>
    <div class="table-wrap"><table>
      <thead><tr>
        <th>Pair</th>
        <th class="num">Papers</th>
        <th class="num" title="Expected if the two subjects were unrelated">Expected</th>
        <th class="num">Verdict</th>
        <th class="num" title="Share of the overlap published since ${RECENT_SINCE}">Recent</th>
        <th>On arXiv</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <p class="hint">
      “Recent” is the share of the overlap published since ${RECENT_SINCE}: a thin pair
      that is also mostly recent is a field opening, a thin pair that is mostly
      old is one that was tried and dropped.
    </p>`;
}

function render(result) {
  el("output").innerHTML = renderTopics(result.topics) + renderPairs(result.pairs);
  const within = result.background ? ` on ${result.background}` : " with abstracts";
  el("status").textContent =
    `Against ${formatNumber(result.corpus)} papers${within} · measured ${new Date(result.at).toLocaleString("en-GB")}`;
}

/* ---------- boot ---------- */

function cached() {
  try {
    const stored = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
    if (!stored) return null;
    // Topics change; a table measured against a list you have since edited
    // would be quietly wrong, so the cache is tied to the exact topic list.
    return stored.signature === signature() ? stored.result : null;
  } catch (error) {
    return null;
  }
}

const signature = () =>
  JSON.stringify([el("background").value, loadTopics().map((topic) => [topic.label, topic.keywords])]);

function run() {
  const topics = loadTopics();
  if (!topics.length) {
    el("output").innerHTML = `<p class="empty-state">
      No topics yet. They are defined in the <a href="index.html">Scanner</a>,
      and this page reads the same list.
    </p>`;
    return;
  }
  if (topics.length > 12) {
    el("status").textContent = `${topics.length} topics means ${topics.length * (topics.length - 1) / 2} pairs — this will take a minute.`;
  }

  el("probe").disabled = true;
  probe(topics)
    .then((result) => {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ signature: signature(), result: {
        ...result,
        // Maps do not survive JSON, so the histograms go back as pairs.
        topics: result.topics.map((topic) => ({ ...topic, years: topic.years ? [...topic.years] : [] })),
        pairs: result.pairs.map((pair) => ({ ...pair, years: [...pair.years] })),
      } }));
      render(result);
    })
    .catch((error) => {
      el("status").textContent = `Could not reach OpenAlex: ${error.message}`;
      console.error(error);
    })
    .finally(() => { el("probe").disabled = false; });
}

function main() {
  document.documentElement.dataset.theme =
    localStorage.getItem("theme") ||
    (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");

  el("theme-toggle").addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("theme", next);
  });

  el("probe").addEventListener("click", run);
  el("clear-cache").addEventListener("click", () => {
    localStorage.removeItem(CACHE_KEY);
    el("output").innerHTML = "";
    el("status").textContent = "Forgotten.";
  });

  const stored = cached();
  if (stored) {
    // Rebuild the Maps the histograms were stored as.
    stored.topics = stored.topics.map((topic) => ({ ...topic, years: new Map(topic.years) }));
    stored.pairs = stored.pairs.map((pair) => ({ ...pair, years: new Map(pair.years) }));
    render(stored);
  } else if (!loadTopics().length) {
    run();   // shows the "no topics yet" state without a round trip
  }
}

main();
