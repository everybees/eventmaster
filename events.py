#!/usr/bin/env python3
"""
winnipeg_events.py — pull upcoming Winnipeg events from several sources into one list.

Sources:
  - Eventbrite (public discovery pages, schema.org JSON-LD)
  - AllEvents.in (aggregates many public Facebook events)
  - Tourism Winnipeg
  - True North / Canada Life Centre & Burton Cummings Theatre
  - Ticketmaster Discovery API (optional, free key: TICKETMASTER_API_KEY)
  - Any extra page you pass with --url (works on most sites using schema.org Event markup)

Standard library only — no pip installs needed.

Usage:
  python3 winnipeg_events.py                      # next 30 days
  python3 winnipeg_events.py --days 7 --pages 3
  python3 winnipeg_events.py --search "afrobeats"
  python3 winnipeg_events.py --category music --category arts   # matches category names or tags
  python3 winnipeg_events.py --category holiday                 # tags: holiday, family, ongoing
  TICKETMASTER_API_KEY=xxxx python3 winnipeg_events.py
  python3 winnipeg_events.py --url https://some-venue.ca/events
"""
import argparse, collections, csv, html, json, os, re, sys, time
import urllib.request, urllib.parse
from datetime import datetime, timedelta, timezone

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")
LOCAL_TZ = timezone(timedelta(hours=-6))  # Winnipeg CST (close enough for filtering)

# name -> list of URL templates; {page} is replaced for paginated sources
JSONLD_SOURCES = {
    "Eventbrite": ["https://www.eventbrite.ca/d/canada--winnipeg/all-events/?page={page}"],
    "AllEvents (incl. Facebook events)": ["https://allevents.in/winnipeg/all?page={page}"],
    "Tourism Winnipeg": ["https://www.tourismwinnipeg.com/events"],
    "True North (Canada Life Centre etc.)": ["https://www.tnse.com/events/"],
}


def fetch(url, timeout=25):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "en-CA,en"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode(r.headers.get_content_charset() or "utf-8", "replace")


TAG_RE = re.compile(r"<[^>]+>")

def clean(s, limit=None):
    """Unescape HTML (including double-encoded '&amp;amp;'), drop tags, collapse whitespace."""
    s = str(s or "")
    for _ in range(3):
        u = html.unescape(s)
        if u == s:
            break
        s = u
    s = re.sub(r"\s+", " ", TAG_RE.sub(" ", s)).strip()
    return s[:limit].rstrip() + "…" if limit and len(s) > limit else s


# ---------- schema.org JSON-LD extraction ----------
LDJSON_RE = re.compile(r'<script[^>]+application/ld\+json[^>]*>(.*?)</script>', re.S | re.I)

def iter_ld_events(node):
    """Recursively yield dicts whose @type is Event or a subtype (MusicEvent, etc.)."""
    if isinstance(node, list):
        for n in node:
            yield from iter_ld_events(n)
    elif isinstance(node, dict):
        t = node.get("@type", "")
        types = t if isinstance(t, list) else [t]
        if any(isinstance(x, str) and x.endswith("Event") for x in types):
            yield node
            return
        for key in ("@graph", "itemListElement", "item", "subEvent"):
            if key in node:
                yield from iter_ld_events(node[key])

def first(v):
    return v[0] if isinstance(v, list) and v else v

def norm_ld(ev, source):
    loc = first(ev.get("location")) or {}
    venue, addr = "", ""
    if isinstance(loc, dict):
        venue = loc.get("name", "") or ""
        a = loc.get("address", "")
        if isinstance(a, dict):
            addr = ", ".join(filter(None, [a.get("streetAddress"), a.get("addressLocality")]))
        else:
            addr = str(a or "")
    offers = first(ev.get("offers")) or {}
    price = ""
    if isinstance(offers, dict):
        lo, hi = offers.get("lowPrice") or offers.get("price"), offers.get("highPrice")
        if lo not in (None, ""):
            price = f"{lo}" + (f"–{hi}" if hi and hi != lo else "")
            if str(lo) in ("0", "0.0", "0.00") and not hi:
                price = "Free"
    free_flag = ev.get("isAccessibleForFree")
    if free_flag in (True, "true", "True", "https://schema.org/True"):
        price = price or "Free"
    elif free_flag in (False, "false", "False", "https://schema.org/False") and not price:
        price = "Paid (price not listed)"
    return {
        "title": clean(ev.get("name")),
        "start": ev.get("startDate", ""),
        "end": ev.get("endDate", ""),
        "venue": clean(venue),
        "address": clean(addr),
        "price": price,
        "url": first(ev.get("url")) or "",
        "source": source,
        "description": clean(ev.get("description")),
    }

def scrape_jsonld(url, source):
    out = []
    for block in LDJSON_RE.findall(fetch(url)):
        try:
            data = json.loads(block.strip())
        except json.JSONDecodeError:
            continue
        out += [norm_ld(e, source) for e in iter_ld_events(data)]
    return out


# ---------- Ticketmaster Discovery API ----------
def ticketmaster(start, end, keyword=None):
    key = os.environ.get("TICKETMASTER_API_KEY")
    if not key:
        return []
    params = {
        "apikey": key, "city": "Winnipeg", "countryCode": "CA", "size": 200, "sort": "date,asc",
        "startDateTime": start.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "endDateTime": end.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    if keyword:
        params["keyword"] = keyword
    data = json.loads(fetch("https://app.ticketmaster.com/discovery/v2/events.json?"
                            + urllib.parse.urlencode(params)))
    out = []
    for e in data.get("_embedded", {}).get("events", []):
        d = e.get("dates", {}).get("start", {})
        v = (e.get("_embedded", {}).get("venues") or [{}])[0]
        pr = (e.get("priceRanges") or [{}])[0]
        segment = ((e.get("classifications") or [{}])[0].get("segment") or {}).get("name", "")
        out.append({
            "title": e.get("name", ""),
            "start": d.get("dateTime") or d.get("localDate", ""),
            "end": "",
            "venue": v.get("name", ""),
            "address": (v.get("address") or {}).get("line1", ""),
            "price": f"{pr.get('min','')}–{pr.get('max','')}" if pr else "",
            "url": e.get("url", ""),
            "source": "Ticketmaster",
            "description": "",
            "category_hint": TM_SEGMENTS.get(segment),
        })
    return out


# ---------- helpers ----------
def parse_dt(s):
    if not s:
        return None
    s = s.strip().replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        try:
            dt = datetime.strptime(s[:10], "%Y-%m-%d")
        except ValueError:
            return None
    return dt if dt.tzinfo else dt.replace(tzinfo=LOCAL_TZ)

FREE_WORDS = re.compile(r"\b(free|no cover|no charge|pay what you can|pwyc)\b", re.I)

def cost_type(e):
    p = (e.get("price") or "").strip()
    if p.lower().startswith("free"):
        return "Free"
    if p.lower().startswith("paid"):
        return "Paid"
    nums = [float(x) for x in re.findall(r"\d+(?:\.\d+)?", p)]
    if nums:
        return "Free" if max(nums) == 0 else "Paid"
    if FREE_WORDS.search(e.get("title", "")):
        return "Free (from title)"
    return "Unknown"

def dedupe_key(e):
    title = re.sub(r"[^a-z0-9]", "", e["title"].lower())[:40]
    dt = e["_dt"].astimezone(LOCAL_TZ).date().isoformat() if e["_dt"] else ""
    return title, dt


# ---------- categorization ----------
def _rx(p):
    return re.compile(p, re.I)

# Checked against the title in this order and the first hit wins, so order matters:
# "Kids STEM Workshop" must reach Family before Professional, "Sustainability Tour at The Leaf"
# Exhibitions before Music ("tour"), and "Holiday Market" Markets before Nightlife.
CATEGORY_RULES = [
    ("Sports & Outdoors", _rx(r"\bvs\.?\b|\bversus\b|\b(jets|moose|bombers|valour|goldeyes)\b|fat bike|"
                              r"\b(run|marathon|5k|10k)\b|hockey|curling|\bski(ing)?\b")),
    ("Social, Dating & Games", _rx(r"speed dating|\bsingles?\b|\bdating\b|new friends|dinner club|"
                                   r"\bmeet-?up\b|trivia|pub quiz|board games?|game night|bingo")),
    ("Markets & Fairs", _rx(r"\bmarkets?\b|bazaar|craft (fair|sale|show)|christkindl|\bvendors?\b|flea")),
    ("Family & Kids", _rx(r"\bkids?\b|children['’]s\b|santa|\belmo\b|\blego\b|\bfamily\b|storytime|"
                          r"toddler|\bages? \d+\s*[-–]\s*1[0-7]\b")),
    ("Professional & Learning", _rx(r"conference|workshop|\bagm\b|annual general meeting|mixer|networking|"
                                    r"training|seminar|webinar|\bresearch\b|therapy|summit|certification|"
                                    r"career|job fair|entrepreneur")),
    ("Talks & Lectures", _rx(r"lecture|\btalks?\b|an evening with|speaking|storytelling|fuckup nights|"
                             r"\bpanel\b|book launch|\bauthor\b|in conversation")),
    ("Wellness", _rx(r"meditat|\bgong\b|sound bath|\byoga\b|breathwork|sauna|reiki|mindful|healing|wellness|"
                     r"somatic|psychic|tarot|\bmedium\b")),
    ("Exhibitions & Attractions", _rx(r"exhibit|gallery|museum|first fridays?|\bwag\b|qaumajuq|guided tour|"
                                      r"walking tour|\btours? (at|of)\b|\bcollection\b|works by")),
    ("Music & Concerts", _rx(r"concert|\blive (at|in|on)\b|\btour\b|choir|chorus|singers|symphony|orchestra|"
                             r"tribute|candlelight|\bdj\b|\bband\b|cumbia|salsa|jazz|blues|\brock\b|hip.?hop|"
                             r"afrobeats?|reggae|metal|punk|\bfolk\b|country|bluegrass|open mic")),
    ("Arts & Theatre", _rx(r"theat(re|er)|\bplay\b|recital|ballet|\bdance\b(?!\s+(party|night))|cabaret|"
                           r"opera|showing|improv|comed(y|ian)|stand-?up|\bdrag\b|musical|presentations|"
                           r"nutcracker|\b(film|movie)s?\b|cinema|poetry|cirque|circus|aerial")),
    ("Community & Fundraisers", _rx(r"fundrais|['’]s social\b|\bgala\b|\bball\b|anniversary|parade|posada|"
                                    r"charity|\bbenefit\b|foundation|celebration|pow ?wow")),
    ("Nightlife & Parties", _rx(r"part(y|ies)|\bbash\b|takeover|nightlife|club night|extravaganza|\brave\b|"
                                r"karaoke|\bnye\b|(bar|pub) crawl")),
    ("Food & Drink", _rx(r"cocktail|brunch|\blunch(eon)?\b|dinner|tasting|\bwine\b|\bbeer\b|whiske?y|distillery|cooking|"
                         r"culinary|\bchef\b")),
]
# Fallback when the title says nothing; only venues that mostly host one kind of event.
VENUE_RULES = [
    ("Music & Concerts", _rx(r"park theatre|times change|burton cummings|concert hall|"
                             r"west end cultural|club regent")),
    ("Nightlife & Parties", _rx(r"pyramid cabaret|nightlife")),
    ("Arts & Theatre", _rx(r"theat(re|er)|arts cent|playhouse|rainbow stage")),
    ("Exhibitions & Attractions", _rx(r"art gallery|museum|qaumajuq|\bthe leaf\b|fortwhyte|assiniboine park")),
]
TM_SEGMENTS = {"Music": "Music & Concerts", "Sports": "Sports & Outdoors", "Arts & Theatre": "Arts & Theatre",
               "Film": "Arts & Theatre", "Family": "Family & Kids"}
CATEGORIES = [c for c, _ in CATEGORY_RULES]  # anything unmatched is "Other"
# catch a typo'd category name, which would otherwise silently become a new category
assert {c for c, _ in VENUE_RULES} | set(TM_SEGMENTS.values()) <= set(CATEGORIES)
HOLIDAY_RE = _rx(r"christmas|xmas|holiday|santa|jingle|posada|christkindl|ornament|hanukk?ah|chanukah|kwanzaa|"
                 r"diwali|new year|\bnye\b|halloween|easter|valentine|winter glow|snow ball|nutcracker|navidad")
FAMILY_RE = dict(CATEGORY_RULES)["Family & Kids"]
MATCHUP_RE = _rx(r"\bvs\.?\b|\bversus\b")

def categorize(e):
    """Return (category, tags). Tries the source's own classification, then title keywords,
    then known venues, then whichever category's keywords appear most in the description."""
    title, desc = e["title"], e.get("description", "")
    cat = (e.get("category_hint")
           or next((c for c, rx in CATEGORY_RULES if rx.search(title)), None)
           or next((c for c, rx in VENUE_RULES if rx.search(e["venue"])), None))
    if not cat and desc:
        # descriptions are noisy, so score every category instead of taking the first hit
        hits, _, best = max((len(rx.findall(desc)), -i, c) for i, (c, rx) in enumerate(CATEGORY_RULES))
        cat = best if hits else None
    cat = cat or "Other"
    tags = []
    if HOLIDAY_RE.search(title):
        tags.append("holiday")
    if cat == "Family & Kids" or FAMILY_RE.search(title):
        tags.append("family")
    if e.get("_dt") and e.get("_end") and e["_end"] - e["_dt"] >= timedelta(days=2):
        tags.append("ongoing")  # multi-day run, e.g. a gallery exhibition
    return cat, tags


def wanted(e, a, now, end):
    """Parse dates, categorize, and apply the command-line filters to one event."""
    if not e["title"]:
        return False
    e["_dt"], e["_end"] = parse_dt(e["start"]), parse_dt(e["end"])
    if MATCHUP_RE.search(e["title"]):
        e["_end"] = None  # a game is one day; AllEvents has listed one with a 10-day endDate
    if e["_dt"]:
        # keep anything still running during the window, not only things that start in it
        last = max(e["_dt"], e["_end"] or e["_dt"])
        if e["_dt"] > end or last < now - timedelta(hours=6):
            return False
    if a.search and a.search.lower() not in (e["title"] + " " + e["venue"]).lower():
        return False
    if a.cost and not cost_type(e).lower().startswith(a.cost):
        return False
    e["category"], e["tags"] = categorize(e)
    labels = " ".join([e["category"], *e["tags"]]).lower()
    return not a.category or any(c.lower() in labels for c in a.category)

def select_events(events, a, now, end):
    """Filter, dedupe and sort. An exhibition re-listed week after week collapses to one row
    spanning all its runs."""
    seen, final = {}, []
    for e in events:
        if not wanted(e, a, now, end):
            continue
        ongoing = "ongoing" in e["tags"]
        k = ("ongoing", dedupe_key(e)[0]) if ongoing else dedupe_key(e)
        if k not in seen:
            seen[k] = e
            final.append(e)
        elif ongoing:
            kept = seen[k]
            kept["_dt"], kept["_end"] = min(kept["_dt"], e["_dt"]), max(kept["_end"], e["_end"])
    # ongoing events that began before today sort as today
    final.sort(key=lambda e: (max(e["_dt"].astimezone(LOCAL_TZ).date(), now.date()), e["_dt"])
               if e["_dt"] else (end.date(), end))
    return final


def main():
    ap = argparse.ArgumentParser(description="Aggregate Winnipeg events.")
    ap.add_argument("--days", type=int, default=30, help="look-ahead window (default 30)")
    ap.add_argument("--pages", type=int, default=2, help="pages per paginated source (default 2)")
    ap.add_argument("--search", help="only keep events whose title/venue contains this text")
    ap.add_argument("--cost", choices=["free", "paid"], help="only keep free or paid events")
    ap.add_argument("--category", action="append", default=[],
                    help="only keep events whose category or tag contains this text (repeatable). "
                         "Categories: " + ", ".join(CATEGORIES) + ", Other. "
                         "Tags: holiday, family, ongoing")
    ap.add_argument("--url", action="append", default=[], help="extra page with schema.org events")
    ap.add_argument("--out", default="winnipeg_events", help="output file prefix")
    ap.add_argument("--delay", type=float, default=1.5, help="seconds between requests")
    a = ap.parse_args()

    now = datetime.now(LOCAL_TZ)
    end = now + timedelta(days=a.days)
    sources = dict(JSONLD_SOURCES)
    for u in a.url:
        sources[urllib.parse.urlparse(u).netloc] = [u]

    events, report = [], []
    for name, templates in sources.items():
        got = 0
        for tpl in templates:
            pages = range(1, a.pages + 1) if "{page}" in tpl else [1]
            for p in pages:
                url = tpl.format(page=p)
                try:
                    batch = scrape_jsonld(url, name)
                except Exception as ex:
                    report.append(f"  ! {name}: {url} -> {ex}")
                    break
                events += batch
                got += len(batch)
                time.sleep(a.delay)
                if not batch:
                    break
        report.append(f"  {name}: {got} found")

    try:
        tm = ticketmaster(now, end, a.search)
        events += tm
        report.append(f"  Ticketmaster: {len(tm)} found" if os.environ.get("TICKETMASTER_API_KEY")
                      else "  Ticketmaster: skipped (set TICKETMASTER_API_KEY)")
    except Exception as ex:
        report.append(f"  ! Ticketmaster -> {ex}")

    final = select_events(events, a, now, end)

    fields = ["date", "until", "time", "category", "tags", "title", "cost", "price", "venue", "address",
              "source", "url", "description"]
    rows = []
    for e in final:
        dt = e["_dt"].astimezone(LOCAL_TZ) if e["_dt"] else None
        until = e["_end"].astimezone(LOCAL_TZ) if "ongoing" in e["tags"] else None
        rows.append({
            "date": dt.strftime("%a %Y-%m-%d") if dt else "",
            "until": until.strftime("%a %Y-%m-%d") if until else "",
            "time": dt.strftime("%I:%M %p").lstrip("0") if dt and (dt.hour or dt.minute) else "",
            "category": e["category"],
            "tags": ";".join(e["tags"]),
            "cost": cost_type(e),
            **{f: e[f] for f in ("title", "venue", "address", "price", "source", "url")},
            "description": clean(e.get("description"), limit=300),
        })
    with open(f"{a.out}.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        w.writerows(rows)
    with open(f"{a.out}.json", "w", encoding="utf-8") as f:
        json.dump(rows, f, indent=2, ensure_ascii=False)

    print("Sources:\n" + "\n".join(report))
    print(f"\n{len(rows)} unique events, {now:%b %d} → {end:%b %d}\n")
    for r in rows:
        print(f"{r['date']} {r['time']:>8}  {r['cost']:<7}  {r['category'][:22]:<22}  "
              f"{r['title'][:50]:<50}  {r['venue'][:24]}")
    counts = collections.Counter(r["category"] for r in rows)
    print("\nBy category: " + ", ".join(f"{c} ({n})" for c, n in counts.most_common()))
    print(f"\nSaved {a.out}.csv and {a.out}.json")


if __name__ == "__main__":
    sys.exit(main())
