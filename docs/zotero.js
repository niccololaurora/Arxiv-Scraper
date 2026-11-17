/* Reads a Zotero library and scores the day's papers against it.
 *
 * Content-based, not collaborative: nobody else's reading is involved and
 * nothing leaves the browser except the calls to Zotero itself. The profile
 * is a bag of weighted terms, which is the only kind of recommender that can
 * answer "why this paper" — and an unexplained ranking of other people's
 * research is not worth reading. */

(() => {

  // Bumped whenever the tokenizer changes: a profile built by an older one
  // holds terms this one will never produce, and every score would be zero
  // without a word of explanation.
  const VERSION = 2;

  const ZOTERO_API = "https://api.zotero.org";
  const ZOTERO_KEY = "zotero-account";     // {userId, key}
  const PROFILE_KEY = "zotero-profile";    // the derived terms, never the library
  const PAGE_SIZE = 100;                        // Zotero's maximum per request
  const PROFILE_TERMS = 400;               // enough to be specific, small enough to store

  /** Words that carry no signal in a physics abstract. "Quantum" is in here on
   *  purpose: in a quant-ph corpus it is as empty as "the". */
  const STOP = new Set(`a an the and or but if of in on at to for with without from by as is are was
  were be been being this that these those we our us they their it its which what when where how
  can could may might will would shall should must do does did not no nor so than then there here
  such only also both each other more most much many few less least very same between into through
  during before after above below over under again further once all any some own just now new
  using used use show shows shown present presents presented study studies propose proposed
  results result model models method methods approach approaches paper work based given find found
  however moreover furthermore thus hence therefore respectively via within obtain obtained
  quantum physics physical system systems state states`.split(/\s+/));

  const words = (text) =>
    text.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter(Boolean);

  /** Longest suffix first, so "squeezing" loses -ing rather than -g. */
  const SUFFIXES = ["ement", "ation", "ing", "ed", "es", "s"];

  /** squeezing, squeezed and squeeze are one subject written three ways, and
   *  a profile that lists them separately spends three of its slots saying
   *  the same thing. Stems are never shown — each one remembers the spelling
   *  it was most often written as, because "squeez" is not a word. */
  function stem(word) {
    let root = word;
    // -ies is a spelling of -y, not a suffix to drop, or "theories" would
    // stem to "theor" while "theory" stayed whole.
    if (root.length >= 5 && root.endsWith("ies")) {
      root = root.slice(0, -3) + "y";
    } else if (root.length >= 5) {
      for (const suffix of SUFFIXES) {
        if (root.endsWith(suffix) && root.length - suffix.length >= 3) {
          root = root.slice(0, -suffix.length);
          break;
        }
      }
    }
    // The final -e goes from every word, short ones included: otherwise
    // "codes" stems to "cod" and "code" stays "code", which is the opposite
    // of the point.
    return root.length > 3 && root.endsWith("e") ? root.slice(0, -1) : root;
  }

  /** Unigrams plus bigrams: "error correction" and "phase space" mean something
   *  their halves do not, and in this field most of the signal is in the pairs. */
  function terms(text) {
    const tokens = words(text);
    const out = [];
    for (let i = 0; i < tokens.length; i++) {
      const word = tokens[i];
      if (word.length > 2 && !STOP.has(word)) out.push(stem(word));
      if (i + 1 < tokens.length && !STOP.has(word) && !STOP.has(tokens[i + 1])) {
        out.push(`${stem(word)} ${stem(tokens[i + 1])}`);
      }
    }
    return out;
  }

  /** The spellings behind the stems, so the panel can show words. */
  function surfaces(text, into) {
    const tokens = words(text);
    for (let i = 0; i < tokens.length; i++) {
      const word = tokens[i];
      if (word.length > 2 && !STOP.has(word)) count(into, stem(word), word);
      if (i + 1 < tokens.length && !STOP.has(word) && !STOP.has(tokens[i + 1])) {
        count(into, `${stem(word)} ${stem(tokens[i + 1])}`, `${word} ${tokens[i + 1]}`);
      }
    }
  }

  function count(into, key, spelling) {
    const seen = into.get(key) || new Map();
    seen.set(spelling, (seen.get(spelling) || 0) + 1);
    into.set(key, seen);
  }

  const commonest = (seen) =>
    [...seen].sort((one, other) => other[1] - one[1])[0][0];

  /* ---------- the arXiv corpus as a yardstick ---------- */

  /** How common each term is across the papers we already hold. Without this,
   *  a profile is dominated by whatever words physics abstracts always use;
   *  with it, a term counts for as much as it is unusual. */
  function documentFrequencies(papers) {
    const df = new Map();
    const seen = new Set();
    for (const paper of papers) {
      if (seen.has(paper.id)) continue;     // a paper announced twice is one document
      seen.add(paper.id);
      for (const term of new Set(terms(`${paper.title} ${paper.abstract}`))) {
        df.set(term, (df.get(term) || 0) + 1);
      }
    }
    return { df, total: seen.size };
  }

  const idf = (corpus, term) =>
    Math.log((corpus.total + 1) / ((corpus.df.get(term) || 0) + 1)) + 1;

  /* ---------- the library ---------- */

  /** The key knows which account it belongs to, so there is no reason to make
   *  anyone go and copy a numeric user id out of a settings page. It also
   *  reports what the key may read, which turns "403 somewhere later" into a
   *  sentence that says what to fix. */
  async function identify(key) {
    const response = await fetch(`${ZOTERO_API}/keys/${encodeURIComponent(key)}`);
    if (response.status === 404) throw new Error("Zotero does not know that key. Check it was copied whole.");
    if (!response.ok) throw new Error(`Zotero answered ${response.status}`);
    const info = await response.json();
    if (!info.access?.user?.library) {
      throw new Error("That key cannot read your library — give it 'Allow library access' on zotero.org.");
    }
    return { userId: String(info.userID), key, username: info.username || "" };
  }

  async function fetchLibrary({ userId, key }, onProgress) {
    const items = [];
    for (let start = 0; ; start += PAGE_SIZE) {
      const url = `${ZOTERO_API}/users/${encodeURIComponent(userId)}/items/top` +
        `?format=json&limit=${PAGE_SIZE}&start=${start}&itemType=-attachment%20||%20note`;
      const response = await fetch(url, { headers: { "Zotero-API-Key": key, "Zotero-API-Version": "3" } });
      if (response.status === 403) throw new Error("Zotero refused the key — check the user id and that the key can read your library.");
      if (!response.ok) throw new Error(`Zotero answered ${response.status}`);
      const page = await response.json();
      items.push(...page);
      onProgress?.(items.length, Number(response.headers.get("Total-Results")) || items.length);
      if (page.length < PAGE_SIZE) return items;
    }
  }

  /** A weighted bag of terms. Each item is normalised before it is added, so a
   *  book with a 2000-word abstract does not outvote fifty papers. */
  function buildProfile(items, corpus) {
    const weights = new Map();
    const mine = new Map();          // how many of your own items use the term
    const spellings = new Map();     // stem -> how each spelling was written
    let used = 0;
    for (const item of items) {
      const data = item.data || {};
      const tags = (data.tags || []).map((tag) => tag.tag).join(" ");
      const text = `${data.title || ""} ${data.abstractNote || ""} ${tags}`;
      const found = terms(text);
      surfaces(text, spellings);
      if (!found.length) continue;
      used++;
      const counts = new Map();
      for (const term of found) counts.set(term, (counts.get(term) || 0) + 1);
      for (const [term, count] of counts) {
        weights.set(term, (weights.get(term) || 0) + (count / found.length) * idf(corpus, term));
        mine.set(term, (mine.get(term) || 0) + 1);
      }
    }

    // Rarity is what gives a term its weight, and nothing stops that from
    // running away: a word so rare that no arXiv paper contains it scores
    // highest of all while being unable to match anything, and it still eats
    // a slot and dilutes the normalisation. A real reader's profile came back
    // led by "trigemini" and "generalized squeezing", neither of which exists
    // in 3422 papers, both of them from one stray item.
    const minItems = used >= 20 ? 2 : 1;
    const useful = [...weights].filter(([term]) =>
      corpus.df.get(term) && mine.get(term) >= minItems);

    const top = useful.sort((one, other) => other[1] - one[1]).slice(0, PROFILE_TERMS);
    const norm = Math.hypot(...top.map(([, weight]) => weight)) || 1;
    return {
      version: VERSION,
      terms: Object.fromEntries(top.map(([term, weight]) => [term, weight / norm])),
      words: Object.fromEntries(top
        .filter(([term]) => spellings.has(term))
        .map(([term]) => [term, commonest(spellings.get(term))])),
      items: items.length,
      withText: used,
      at: new Date().toISOString(),
    };
  }

  /** Cosine similarity between a paper and the profile, with the terms that
   *  carried it — the score alone is a number nobody can argue with. */
  function score(paper, profile, corpus) {
    const found = terms(`${paper.title} ${paper.abstract}`);
    if (!found.length) return { score: 0, because: [] };

    const counts = new Map();
    for (const term of found) counts.set(term, (counts.get(term) || 0) + 1);

    let dot = 0, length = 0;
    const shared = [];
    for (const [term, count] of counts) {
      const weight = (count / found.length) * idf(corpus, term);
      length += weight * weight;
      const mine = profile.terms[term];
      if (mine) {
        dot += weight * mine;
        shared.push([term, weight * mine]);
      }
    }
    if (!dot) return { score: 0, because: [] };

    shared.sort((one, other) => other[1] - one[1]);
    return {
      score: dot / (Math.sqrt(length) || 1),
      // Bigrams first among equals: "phase space" explains a match, "space" does not.
      because: shared.slice(0, 4).map(([term]) => term),
    };
  }

  /* ---------- storage: the profile, never the library ---------- */

  const loadAccount = () => {
    try {
      return JSON.parse(localStorage.getItem(ZOTERO_KEY) || "null");
    } catch (error) {
      return null;
    }
  };

  const saveAccount = (account) =>
    account ? localStorage.setItem(ZOTERO_KEY, JSON.stringify(account)) : localStorage.removeItem(ZOTERO_KEY);

  const loadProfile = () => {
    try {
      const stored = JSON.parse(localStorage.getItem(PROFILE_KEY) || "null");
      return stored && stored.version === VERSION ? stored : null;
    } catch (error) {
      return null;
    }
  };

  const saveProfile = (profile) =>
    profile ? localStorage.setItem(PROFILE_KEY, JSON.stringify(profile)) : localStorage.removeItem(PROFILE_KEY);

  window.Zotero = {
    identify, fetchLibrary, buildProfile, score, documentFrequencies, stem,
    loadAccount, saveAccount, loadProfile, saveProfile, terms,
  };

})();
