# quant-ph topic scanner

A web interface to see which `quant-ph` papers appeared on arXiv **in the last
day, week or month**, filtered by topic.

A Python scraper runs daily on GitHub Actions, pulls recent submissions from the
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
- **`docs/data/topics.json`** — the topic taxonomy: 22 topics in 5 groups, each
  with its own keywords. **It is meant to be edited by hand** (see below).
- **`docs/data/members.json`** — the group roster, hand-edited. The scraper
  queries arXiv for these authors and writes `group.json`, which feeds the
  "From the group" panel on the right.
- **`docs/app.js`** — computes each paper's topics once at load time, after
  which every filter is a set lookup.

### The group panel

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
  `?days=7&topics=qec,qml&mode=all`.

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
the data and redeploys the site daily at 07:00 UTC, and on every push to `main`.

It needs to be enabled once: **Settings → Pages → Source: GitHub Actions**.

> `docs/data/papers.json` is in `.gitignore` on purpose. It is generated in CI on
> every deploy; committing it would add ~4 MB to the repository history every
> single day.

## Customising the topics

Everything lives in `docs/data/topics.json`:

```json
{
  "id": "qec",
  "label": "Quantum error correction",
  "keywords": ["quantum error correction", "QEC", "surface code", "decoder"]
}
```

The site reads this file on every page load, so adding or fixing a topic
**does not require re-running the scraper**: edit, reload, done.

A few caveats:

- avoid short or ambiguous acronyms (`QEC` is fine, `QC` produces a flood of
  false positives);
- keywords are matched against title + abstract, not against arXiv categories;
- `id` values appear in shared URLs, so renaming one breaks existing links —
  change the `label` freely, but keep the `id`.

The taxonomy is deliberately focused on the group's own areas rather than on
covering all of quant-ph, so on the most recent week of data it tags about 79%
of papers. What falls through is mostly maths and nuclear cross-lists, plus the
subfields intentionally left out (QKD, quantum networks, complexity,
condensed-matter many-body, lattice QFT, control, benchmarking, compilation).
Adding any of them back is a matter of appending one entry to this file.

---

Data provided by the arXiv API. Thank you to arXiv for use of its open access
interoperability.
