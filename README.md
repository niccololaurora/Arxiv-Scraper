# quant-ph topic scanner

A web interface to see which `quant-ph` papers appeared on arXiv **in the last
day, week or month**, filtered by topics **you define yourself**.

There is no built-in taxonomy: a topic is a name and a handful of keywords, you
write them, and they live in your browser. Two people reading the same feed
end up with two different sidebars, which is the point — nobody has to agree on
how to carve up quant-ph.

A Python scraper runs on GitHub Actions a few times a day, pulls recent submissions from the
[arXiv API](https://info.arxiv.org/help/api/index.html) and publishes a static
site to GitHub Pages. No server and no database: all filtering happens in the
browser, so it is instant.

A project of the [Pure and Applied Quantum Mechanics Group](https://sites.unimi.it/aqm/),
Department of Physics, University of Milan.

## How it works

```
scraper/fetch_arxiv.py   →  docs/data/papers.json   →  docs/ (static site)
   arXiv API, stdlib            ~2200 papers             vanilla JS
                          →  docs/data/group.json
                             the group's own recent submissions
```

- **`scraper/fetch_arxiv.py`** — pages through the arXiv API over a
  `submittedDate` window, deduplicates, and writes a compact JSON. Standard
  library only, and it honours the 3 s delay arXiv asks for between calls.
- **`docs/data/members.json`** — the group roster, hand-edited. The scraper
  queries arXiv for these authors and writes `group.json`, which feeds the
  "From the group" panel on the right.
- **`docs/app.js`** — reads your topics from `localStorage`, matches each paper
  against them once at load time, after which every filter is a set lookup.

### New, cross-lists and replacements

Three buttons above the feed split it the way arXiv announces a day, and the
counts always add up to the total — every paper is in exactly one:

| | what it is |
|---|---|
| **New** | first version, submitted straight to quant-ph |
| **Cross-lists** | submitted to another archive, cross-listed into quant-ph |
| **Replacements** | revised since it was first submitted (v2 or later) |

**Replacements are narrower here than on arXiv.** The API's date filters only
ever match the v1 submission date — querying `lastUpdatedDate` for the last
four days returns nothing submitted before them — so a paper from last year
revised this morning is not in the dataset at all. What this bucket holds is
papers submitted *inside* the window that have since gained a version.

### The group panel and the authors you follow

The right-hand column collapses to its heading, and under it you can follow
any author by name. Their papers are found in the data already in the browser,
so there is no request to make and the list updates by itself as the data is
refreshed — but it only reaches as far as the data does: the last 35 days of
quant-ph, plus whatever `group.json` holds for a group member.

An author matches only if **both** surname and first name agree, so `M. Paris`
counts for Matteo Paris while `Michel Paris` does not. Names alone still cannot
identify a person — a LIGO paper by a different Priyanka Sharma matched during
testing — so results are additionally restricted to the category prefixes
listed in `members.json`. Widen that list if someone publishes outside it, or
empty it to turn the filter off.

Details worth knowing:

- The time window is measured **from the newest submission in the data**, not
  from the current time: arXiv publishes in daily batches, so a literal "last
  day" would be empty for most of the day.
- The feed has no pages: it grows by 25 as you scroll, and any change of
  filter puts you back at the top.
- Keyword matching tolerates singular/plural (`surface code` also finds
  `surface codes`) and treats hyphens and spaces as equivalent (`non-Markovian`
  = `non Markovian`).
- The search box covers **titles, abstracts and author names**, so
  `Tomamichel` works as an author search. Terms are anchored at the start of a
  word but left open at the end: `ion` finds `ions` and `trapped-ion` but not
  `dimensions`, while typing `entangl` already narrows the results. Multiple
  terms combine with AND, and quotes keep a phrase together — so
  `spin squeezing` (two terms) and `"spin squeezing"` (one phrase) give
  different results.
- Filter state is reflected in the URL, so a filtered view is shareable:
  `?days=7&topics=gaussian-states&kinds=new,cross&mode=all`. Topic ids are
  derived from the name, so a link only resolves for someone whose own topics
  carry the same names — send them your exported JSON and it will.

## Running it locally

```bash
python3 scraper/fetch_arxiv.py --days 35   # writes docs/data/papers.json
python3 -m http.server 8000 --directory docs
# open http://localhost:8000
```

An HTTP server is required: opening `docs/index.html` as a `file://` URL makes
the browser block the data `fetch`.

## Deploying to GitHub Pages

[`update-and-deploy.yml`](.github/workflows/update-and-deploy.yml) regenerates
the data and redeploys the site three times a day — 02:23, 09:23 and 15:23 UTC
— and on every push to `main`.

Three and not one because a scheduled workflow is not punctual: GitHub queues
them on a best-effort basis, and a single daily `0 7` fired at 13:58, 14:34 and
16:50 UTC on three consecutive days. The first run is the one that matters,
since arXiv announces the day's batch at 01:00 UTC and the API only indexes it
then; the other two bound how stale the site can get. Note also that GitHub
**disables scheduled workflows** in a repository with no activity for 60 days,
which is the first thing to check if the data silently stops moving.

It needs to be enabled once: **Settings → Pages → Source: GitHub Actions**.

> `docs/data/papers.json` is in `.gitignore` on purpose. It is generated in CI on
> every deploy; committing it would add ~4 MB to the repository history every
> single day.

## Making your own topics

**+ New topic** in the sidebar asks for a name and a comma-separated list of
keywords, and tells you how many papers they match **while you type** — which
is the only reliable way to find out that `QC` hits half the archive before you
save it.

A few things worth knowing:

- keywords are matched against title + abstract, never against arXiv
  categories, so `superconducting qubit` finds papers, `cond-mat.supr-con`
  does not;
- prefer the specific phrase over the generic word (`variational Monte Carlo`,
  not `Monte Carlo`) and acronyms long enough to be unambiguous (`QEC` is fine,
  `QC` is not);
- the same accommodations as the search box apply: singular/plural
  (`surface code` also finds `surface codes`) and hyphens equal spaces
  (`non-Markovian` = `non Markovian`).

Topics live in `localStorage`, so they are per-browser and survive reloads but
not a new laptop. **export** downloads them as JSON and **import** reads them
back, which is also how you hand a working set of topics to a colleague:

```json
[
  {
    "id": "gaussian-states",
    "label": "Gaussian states",
    "keywords": ["Gaussian state", "covariance matrix", "squeezed vacuum"]
  }
]
```

`id` is optional on import — it is derived from the name when missing — and
importing a name you already have is skipped rather than duplicated, so
re-importing the same file twice is harmless.

---

Data provided by the arXiv API. Thank you to arXiv for use of its open access
interoperability.
