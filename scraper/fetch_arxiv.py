#!/usr/bin/env python3
"""Fetch recent quant-ph submissions from the arXiv API into a static JSON file.

Only the standard library is used so the GitHub Action needs no dependencies.

Usage:
    python scraper/fetch_arxiv.py [--days 35] [--out docs/data/papers.json]
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from pathlib import Path

API_URL = "https://export.arxiv.org/api/query"
CATEGORY = "cat:quant-ph"
PAGE_SIZE = 200
# arXiv asks for a 3 second pause between consecutive API calls.
REQUEST_DELAY = 3.0
MAX_RETRIES = 4
USER_AGENT = "Scraper-Arxiv/1.0 (https://github.com/niccololaurora/Arxiv-Scraper)"

# What arXiv announced on a given day, which is not the same question as what
# was submitted that day: a paper held by moderation is announced days after
# its submission date, and six of those were missing from the site on the day
# this was written. The API cannot answer it — its date filters only ever see
# the v1 submission date — but the catchup page can, and arXiv's robots.txt
# allows /catchup explicitly, asking for 15 seconds between requests.
CATCHUP_URL = "https://arxiv.org/catchup/quant-ph/{day}"
CRAWL_DELAY = 15.0
LISTINGS = 20          # announcement days to keep, "Month" on the site
SECTIONS = {
    "New submissions": "new",
    "Cross submissions": "cross",
    "Replacement submissions": "replace",
}
# Metadata already published is reused rather than fetched again: a normal run
# then needs one catchup page and one batch of metadata instead of twenty.
PUBLISHED_URL = "https://niccololaurora.github.io/Arxiv-Scraper/data/papers.json"
ID_BATCH = 100

NS = {
    "atom": "http://www.w3.org/2005/Atom",
    "arxiv": "http://arxiv.org/schemas/atom",
}


def date_window(since: datetime, until: datetime) -> str:
    return "submittedDate:[{} TO {}]".format(
        since.strftime("%Y%m%d%H%M"), until.strftime("%Y%m%d%H%M")
    )


def build_url(search_query: str, start: int) -> str:
    params = {
        "search_query": search_query,
        "start": start,
        "max_results": PAGE_SIZE,
        "sortBy": "submittedDate",
        "sortOrder": "descending",
    }
    return f"{API_URL}?{urllib.parse.urlencode(params)}"


def build_query(start: int, since: datetime, until: datetime) -> str:
    """Build an API query restricted to a submission date window."""
    return build_url(f"{CATEGORY} AND {date_window(since, until)}", start)


def fetch_page(url: str) -> str:
    """GET a single API page, retrying with backoff on transient failures."""
    last_error: Exception | None = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(request, timeout=60) as response:
                return response.read().decode("utf-8")
        except (urllib.error.URLError, TimeoutError) as error:
            last_error = error
            backoff = REQUEST_DELAY * 2**attempt
            print(f"  request failed ({error}); retrying in {backoff:.0f}s", file=sys.stderr)
            time.sleep(backoff)
    raise RuntimeError(f"giving up on {url}: {last_error}")


def clean(text: str | None) -> str:
    """Collapse the newlines and padding the Atom feed wraps text in."""
    if not text:
        return ""
    return " ".join(text.split())


def parse_entry(entry: ET.Element) -> dict | None:
    raw_id = clean(entry.findtext("atom:id", default="", namespaces=NS))
    if not raw_id:
        return None
    # http://arxiv.org/abs/2511.01234v2 -> ("2511.01234", 2)
    tail = raw_id.rsplit("/abs/", 1)[-1]
    arxiv_id, _, version = tail.partition("v")

    categories = [
        category.get("term", "")
        for category in entry.findall("atom:category", NS)
        if category.get("term")
    ]
    primary = entry.find("arxiv:primary_category", NS)

    pdf_url = f"https://arxiv.org/pdf/{tail}"
    for link in entry.findall("atom:link", NS):
        if link.get("title") == "pdf" and link.get("href"):
            pdf_url = link.get("href", "").replace("http://", "https://")

    return {
        "id": arxiv_id,
        "version": int(version) if version.isdigit() else 1,
        "title": clean(entry.findtext("atom:title", default="", namespaces=NS)),
        "abstract": clean(entry.findtext("atom:summary", default="", namespaces=NS)),
        "authors": [
            clean(name)
            for author in entry.findall("atom:author", NS)
            if (name := author.findtext("atom:name", default="", namespaces=NS))
        ],
        "published": clean(entry.findtext("atom:published", default="", namespaces=NS)),
        "updated": clean(entry.findtext("atom:updated", default="", namespaces=NS)),
        "primary_category": primary.get("term", "") if primary is not None else "",
        "categories": categories,
        "comment": clean(entry.findtext("arxiv:comment", default="", namespaces=NS)),
        "journal_ref": clean(entry.findtext("arxiv:journal_ref", default="", namespaces=NS)),
        "doi": clean(entry.findtext("arxiv:doi", default="", namespaces=NS)),
        "abs_url": f"https://arxiv.org/abs/{tail}",
        "pdf_url": pdf_url,
    }


def fetch_all(search_query: str, papers: dict[str, dict] | None = None) -> dict[str, dict]:
    """Page through every result of a query, de-duplicated by arXiv id."""
    papers = {} if papers is None else papers
    start = 0
    while True:
        print(f"  start={start} (collected {len(papers)})")
        feed = ET.fromstring(fetch_page(build_url(search_query, start)))
        entries = feed.findall("atom:entry", NS)
        if not entries:
            break

        for entry in entries:
            paper = parse_entry(entry)
            # The API can repeat entries across page boundaries; keep one copy.
            if paper and paper["id"] not in papers:
                papers[paper["id"]] = paper

        total = feed.findtext("opensearch:totalResults", namespaces={
            "opensearch": "http://a9.com/-/spec/opensearch/1.1/"
        })
        start += PAGE_SIZE
        if total and start >= int(total):
            break
        time.sleep(REQUEST_DELAY)
    return papers


# --- what arXiv announced, day by day ------------------------------------

def fetch_listing(day: str) -> dict[str, str]:
    """{arXiv id -> new|cross|replace} exactly as arXiv listed it on `day`.

    Ids are read out of the <dt> elements that open each entry rather than
    from the page at large, so an abstract quoting another paper's id cannot
    smuggle it into the listing.
    """
    page = fetch_page(CATCHUP_URL.format(day=day))
    sections = [
        (match.start(), SECTIONS[match.group(1)])
        for match in re.finditer(r"(%s) \(showing" % "|".join(SECTIONS), page)
    ]
    listing: dict[str, str] = {}
    for entry in re.finditer(r"<dt>.*?</dt>", page, re.S):
        found = re.search(r"/abs/(\d{4}\.\d{4,5})", entry.group(0))
        if not found:
            continue
        kinds = [kind for start, kind in sections if start < entry.start()]
        if kinds:
            listing.setdefault(found.group(1), kinds[-1])
    return listing


def listing_days(wanted: int, known: dict[str, dict[str, str]]) -> dict[str, dict[str, str]]:
    """Walk back from today until `wanted` days with a listing are collected.

    Saturdays and Sundays are skipped without asking; a weekday that comes
    back empty is a holiday, which costs one request and does not count.
    """
    listings: dict[str, dict[str, str]] = {}
    day = datetime.now(timezone.utc).date()
    for _ in range(wanted * 2 + 14):          # a fortnight of slack for holidays
        if len(listings) == wanted:
            break
        if day.weekday() < 5:
            key = day.isoformat()
            if key in known:
                listings[key] = known[key]
                print(f"  {key}: {len(known[key])} entries (already published)")
            else:
                found = fetch_listing(key)
                if found:
                    listings[key] = found
                    print(f"  {key}: {len(found)} entries")
                time.sleep(CRAWL_DELAY)
        day -= timedelta(days=1)
    return listings


def fetch_metadata(ids: list[str], have: dict[str, dict]) -> dict[str, dict]:
    """Metadata for ids not already carried over, in batches by id_list."""
    missing = [arxiv_id for arxiv_id in ids if arxiv_id not in have]
    papers = dict(have)
    for start in range(0, len(missing), ID_BATCH):
        batch = missing[start:start + ID_BATCH]
        print(f"  metadata {start + 1}-{start + len(batch)} of {len(missing)}")
        url = f"{API_URL}?{urllib.parse.urlencode({'id_list': ','.join(batch), 'max_results': ID_BATCH})}"
        feed = ET.fromstring(fetch_page(url))
        for entry in feed.findall("atom:entry", NS):
            paper = parse_entry(entry)
            if paper:
                papers[paper["id"]] = paper
        time.sleep(REQUEST_DELAY)
    return papers


def load_published(url: str) -> list[dict]:
    """The dataset already on the site, so a run only fetches the difference."""
    try:
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(request, timeout=120) as response:
            return json.loads(response.read().decode("utf-8")).get("papers", [])
    except Exception as error:                 # a cold start is not a failure
        print(f"  no published dataset to reuse ({error})", file=sys.stderr)
        return []


def fetch_announced(url: str, wanted: int) -> list[dict]:
    """Every paper arXiv announced over the last LISTINGS listing days."""
    published = load_published(url)
    carried = {paper["id"]: paper for paper in published}
    known: dict[str, dict[str, str]] = {}
    for paper in published:
        if "announced" in paper:
            known.setdefault(paper["announced"], {})[paper["id"]] = paper["announce_type"]

    print(f"Collecting the last {wanted} arXiv listings ({len(carried)} papers already published)")
    listings = listing_days(wanted, known)

    # A list and not a dict keyed by id: the same paper is announced twice when
    # it is posted one day and revised another, and arXiv lists it both times.
    # Keying by id silently dropped seven replacements from a single day.
    entries = [(arxiv_id, day, kind)
               for day, listed in listings.items() for arxiv_id, kind in listed.items()]
    papers = fetch_metadata(sorted({arxiv_id for arxiv_id, _, _ in entries}), carried)

    announced = []
    for arxiv_id, day, kind in entries:
        paper = papers.get(arxiv_id)
        if paper:
            announced.append({**paper, "announced": day, "announce_type": kind})
        else:
            print(f"  no metadata for {arxiv_id}, skipped", file=sys.stderr)
    # Newest listing first, and within a listing the newest submission first.
    announced.sort(key=lambda paper: (paper["announced"], paper["published"]), reverse=True)
    return announced


def by_date(papers) -> list[dict]:
    return sorted(papers, key=lambda paper: paper["published"], reverse=True)


def fetch_window(days: int) -> list[dict]:
    """Page through every quant-ph submission from the last `days` days."""
    until = datetime.now(timezone.utc)
    since = until - timedelta(days=days)
    print(f"Fetching quant-ph submissions from {since:%Y-%m-%d} to {until:%Y-%m-%d}")
    return by_date(fetch_all(f"{CATEGORY} AND {date_window(since, until)}").values())


# --- group submissions -----------------------------------------------------

def strip_accents(text: str) -> str:
    decomposed = unicodedata.normalize("NFKD", text)
    return "".join(char for char in decomposed if not unicodedata.combining(char))


def name_parts(name: str) -> tuple[str, str]:
    """('Matteo G. A. Paris') -> ('matteo', 'paris')"""
    tokens = strip_accents(name).lower().replace(".", " ").split()
    return (tokens[0], tokens[-1]) if len(tokens) > 1 else ("", tokens[0] if tokens else "")


def build_member_index(members: list[dict]) -> dict[tuple[str, str], str]:
    """Map (first name, surname) -> display name, including any aliases."""
    index = {}
    for member in members:
        for spelling in [member["name"], *member.get("aliases", [])]:
            index[name_parts(spelling)] = member["name"]
    return index


def match_author(author: str, index: dict[tuple[str, str], str]) -> str | None:
    """Match on surname plus first name, accepting 'M. Paris' for 'Matteo Paris'.

    Requiring the first name is what keeps common surnames (Sharma, Gupta)
    from pulling in unrelated authors.
    """
    first, last = name_parts(author)
    for (want_first, want_last), display in index.items():
        if last != want_last:
            continue
        if first == want_first or (len(first) == 1 and first == want_first[:1]):
            return display
    return None


def in_categories(paper: dict, prefixes: list[str]) -> bool:
    if not prefixes:
        return True
    return any(category.startswith(prefix)
               for category in paper["categories"] for prefix in prefixes)


def fetch_group(members: list[dict], days: int, categories: list[str] | None = None) -> list[dict]:
    """Fetch recent submissions by group members.

    Names alone cannot identify a person — a LIGO author sharing a member's
    name matched here — so results are also restricted to `categories`.
    """
    until = datetime.now(timezone.utc)
    since = until - timedelta(days=days)
    index = build_member_index(members)
    window = date_window(since, until)
    categories = categories or []

    print(f"Fetching group submissions by {len(members)} members")
    collected: dict[str, dict] = {}
    # Query in small batches: one OR-clause per member makes a very long URL.
    for batch_start in range(0, len(members), 8):
        batch = members[batch_start:batch_start + 8]
        clause = " OR ".join(f'au:"{member["name"]}"' for member in batch)
        print(f"  members {batch_start + 1}-{batch_start + len(batch)}")
        fetch_all(f"({clause}) AND {window}", collected)
        time.sleep(REQUEST_DELAY)

    # The API matches author names loosely, so confirm each hit ourselves.
    papers, off_topic = [], 0
    for paper in collected.values():
        matched = sorted({name for author in paper["authors"]
                          if (name := match_author(author, index))})
        if not matched:
            continue
        if not in_categories(paper, categories):
            off_topic += 1
            print(f"  skipped (categories {paper['categories']}): {paper['title'][:50]}")
            continue
        papers.append({**paper, "members": matched})

    print(f"  {len(papers)} confirmed out of {len(collected)} candidates"
          f" ({off_topic} dropped by the category filter)")
    return by_date(papers)


def write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
    print(f"Wrote {path} ({path.stat().st_size / 1_048_576:.1f} MB)")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--listings", type=int, default=LISTINGS,
                        help="how many arXiv announcement days to keep")
    parser.add_argument("--published", default=PUBLISHED_URL,
                        help="dataset to reuse metadata from; '' to fetch everything afresh")
    parser.add_argument("--out", type=Path, default=Path("docs/data/papers.json"))
    parser.add_argument("--members", type=Path, default=Path("docs/data/members.json"))
    parser.add_argument("--group-out", type=Path, default=Path("docs/data/group.json"))
    parser.add_argument("--group-days", type=int, default=30,
                        help="window for the group's own submissions")
    args = parser.parse_args()

    papers = fetch_announced(args.published, args.listings)
    if not papers:
        print("No papers returned; leaving the existing file untouched.", file=sys.stderr)
        return 1

    listings = sorted({paper["announced"] for paper in papers}, reverse=True)
    generated_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    write_json(args.out, {
        "generated_at": generated_at,
        "listings": listings,
        "count": len(papers),
        "papers": papers,
    })

    if args.members.exists():
        config = json.loads(args.members.read_text(encoding="utf-8"))
        group = fetch_group(config["members"], args.group_days, config.get("categories"))
        write_json(args.group_out, {
            "generated_at": generated_at,
            "window_days": args.group_days,
            "group_name": config.get("group_name", ""),
            "group_url": config.get("group_url", ""),
            "count": len(group),
            "papers": group,
        })
    else:
        print(f"No {args.members}; skipping the group panel.", file=sys.stderr)

    return 0


if __name__ == "__main__":
    sys.exit(main())
