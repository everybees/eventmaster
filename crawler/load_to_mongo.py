#!/usr/bin/env python3
"""
load_to_mongo.py — crawl one city's sources (the same crawl as events.py) and upsert its events into MongoDB.

Meant to run on a schedule, once per city (.github/workflows/crawl.yml). Each event is one document keyed
by its stable ID, so a re-crawl updates it in place. A city's events missing from two of its healthy runs
in a row are marked "removed" (not those added by hand: crawler/suggestions.py). Every run writes a `runs`
document with per-source counts. The script exits with status 2 when a source that returned events last run
returns none, and 3 when the run found under half as many events as the city's last one, so the scheduled job
fails and GitHub notifies you.

  MONGODB_URI=mongodb+srv://… python3 crawler/load_to_mongo.py --city calgary
  python3 crawler/load_to_mongo.py --dry-run      # crawl and print a sample; no database needed

Needs pymongo (pip install -r crawler/requirements.txt), except for --dry-run.
"""
import argparse, collections, json, os, re, sys, time
from datetime import datetime, timedelta, timezone

import events as E

DEFAULT_DB = "wpg_events"
REMOVE_AFTER_MISSED_RUNS = 2
HEALTHY_SHARE = 0.5               # a run with under half the last run's events removes nothing
FEED_GRACE = timedelta(hours=6)   # as in events.wanted(): an event stays listed this long after it ends
KEEP_AFTER_END = timedelta(days=30)  # and in the database this long, for "Did you go?" answers and popularity
TICKET_RECHECK = timedelta(hours=24)  # how often an AllEvents page is fetched again for its ticket link
SYNOPSIS_RECHECK = timedelta(days=7)  # how often a film's page is fetched again for its synopsis
# Requested cities (the app's "add my city"): see netlify/functions/city-requests.mts
MAX_REQUESTED_CITIES = 50  # crawled at once, most requested first; the rest wait
MIN_EVENTS = 5             # a requested city goes live once a crawl finds at least this many events
FAILED_SOURCE_RE = re.compile(r"^\s*! (.+?)(?::| ->) ")  # "  ! AllEvents (…): https://… -> HTTP Error 405"
# sources with an event in a city every few weeks: a run that finds none of them there is normal, not a broken
# source (one that fails still alerts)
SPARSE_SOURCES = {E.BEYOND30_SOURCE}


def to_doc(e):
    """An event as select_events() leaves it -> its MongoDB document (without the bookkeeping fields).

    startLocal/endLocal/times are Winnipeg wall-clock values ("2026-11-23T19:00", "19:00"). The app
    shows them as written, so a server or source with outdated time-zone rules can't shift them.
    start/end are the same moments in UTC, for sorting and filtering."""
    start = e["_dt"]
    end = e["_end"] if "ongoing" in e["tags"] else None
    local_times = [t.astimezone(E.LOCAL_TZ) for t in e.get("_times", [start])]
    times = sorted({t.strftime("%H:%M") for t in local_times if t.hour or t.minute})
    all_day = not times  # listed with a date only
    day = start.astimezone(E.LOCAL_TZ).date().isoformat()
    end_date_only = bool(end) and len(e["end"].strip()) == 10
    last = max(start, end or start)
    if (end and end_date_only) or (not end and all_day):
        last += timedelta(days=1)  # a bare date lasts all day
    cost = E.cost_type(e)
    free = cost.startswith("Free")
    doc = {
        "_id": E.stable_id(e),
        "city": E.CITY,
        "title": e["title"],
        "category": e["category"],
        "tags": e["tags"],
        "start": start.astimezone(timezone.utc),
        "end": end.astimezone(timezone.utc) if end else None,
        "startLocal": day if all_day else f"{day}T{times[0]}",
        "endLocal": (end.astimezone(E.LOCAL_TZ).date().isoformat() if end_date_only
                     else end.astimezone(E.LOCAL_TZ).strftime("%Y-%m-%dT%H:%M")) if end else None,
        "allDay": all_day,
        "times": times,
        "venue": {"name": e["venue"], "address": e["address"]},
        "price": {"text": e.get("price") or "", "free": True if free else (False if cost == "Paid" else None),
                  "currency": e.get("currency") or None},
        "cost": "Free" if free else cost,
        "image": e.get("image") or None,
        "description": E.clean(e.get("description"), limit=1200),
        "url": e["url"],
        "source": e["source"],
        "showtimes": e.get("_showtimes", []),
        "visibleUntil": (last + FEED_GRACE).astimezone(timezone.utc),
        "expireAt": (last + KEEP_AFTER_END).astimezone(timezone.utc),  # TTL index deletes it then
    }
    if "_ticket_checked" in e:  # only when looked up, so a run that skips the lookup keeps the last answer
        doc["ticketUrl"], doc["ticketCheckedAt"] = e["_ticket_url"] or None, e["_ticket_checked"]
    if e.get("_synopsis_checked"):  # films: the synopsis on its own, so other cities and later runs can reuse it
        doc["synopsis"], doc["synopsisCheckedAt"] = e["_synopsis"], e["_synopsis_checked"]
    return doc


def build_docs(selected):
    """Documents for every dated event, first one wins if two share an ID."""
    docs = {}
    for e in selected:
        if e["_dt"]:
            d = to_doc(e)
            docs.setdefault(d["_id"], d)
    return list(docs.values())


def requested_city(doc):
    """Crawl settings for a city someone asked for (a `cityRequests` document), in shared/cities.json's
    shape: AllEvents (both its usual pages and the city home page, since cities differ in which carries
    the data), Ticketmaster (it finds nothing where it doesn't sell, at the cost of one request) and
    Eventbrite when enabled. No cinemas: those are set up by hand."""
    ae = re.sub(r"[^a-z0-9]+", "-", E.norm(doc["ascii"])).strip("-")
    country = re.sub(r"[^a-z0-9]+", "-", E.norm(doc["countryName"])).strip("-")
    return {
        "name": doc["name"], "region": doc.get("region", ""), "country": doc["country"],
        "countryName": doc.get("countryName", ""),
        "timezone": doc["timezone"], "currency": doc.get("currency") or "USD", "lat": doc["lat"], "lon": doc["lon"],
        "requested": True,
        "crawl": {
            "eventbrite": f"{country}--{ae}", "allevents": ae,
            "allEventsPages": {
                "AllEvents (incl. Facebook events)": [f"https://allevents.in/{ae}/all?page={{page}}",
                                                      f"https://allevents.in/{ae}?page={{page}}"],
                "AllEvents (movies & film)": [f"https://allevents.in/{ae}/movies?page={{page}}"],
            },
            "ticketmaster": {"city": doc["name"], "countryCode": doc["country"]},
            "cinemaclock": [], "sources": {}, "sourceVenues": {}, "venueRules": {},
        },
    }


def cities_to_crawl(db):
    """The configured cities, then requested ones still waiting for a first crawl or live, most requested
    first and capped. Without a database, just the configured ones."""
    static = list(E.CITIES)
    if db is None:
        return static
    docs = db.cityRequests.find({"status": {"$in": ["pending", "active"]}}, {"_id": 1}) \
        .sort([("requests", -1), ("firstRequestedAt", 1)]).limit(MAX_REQUESTED_CITIES)
    return static + [d["_id"] for d in docs if d["_id"] not in E.CITIES]


def mark_requested_city(db, slug, run):
    """After a requested city's crawl: live once it has enough events, else unavailable (the app says so;
    it's tried again if someone asks after a month)."""
    status = "active" if run["total"] >= MIN_EVENTS else "unavailable"
    db.cityRequests.update_one({"_id": slug}, {"$set": {
        "status": status, "eventCount": run["total"], "lastCrawledAt": run["finishedAt"]}})
    return status


def known_synopses(db, now):
    """Film synopses fetched in the last week, in any city: {film page URL: (synopsis, when fetched)}."""
    docs = db.events.find({"synopsisCheckedAt": {"$gte": now - SYNOPSIS_RECHECK}},
                          {"url": 1, "synopsis": 1, "synopsisCheckedAt": 1})
    return {d["url"]: (d.get("synopsis") or "", d["synopsisCheckedAt"]) for d in docs}


def known_ticket_links(db, selected):
    """What the database already knows about the AllEvents events in this crawl: {id: document}."""
    ids = [E.stable_id(e) for e in selected if e["source"].startswith("AllEvents") and e["_dt"]]
    return {d["_id"]: d for d in db.events.find({"_id": {"$in": ids}}, {"ticketUrl": 1, "ticketCheckedAt": 1})}


def add_ticket_links(selected, known, now, delay):
    """AllEvents listings don't say who sells the tickets; each event's own page does. Look that up,
    at most once a day per event (`known` holds the last answers). Returns the number of pages fetched."""
    fetched = 0
    for e in selected:
        if not e["source"].startswith("AllEvents") or not e["_dt"]:
            continue
        k = known.get(E.stable_id(e)) or {}
        if k.get("ticketCheckedAt") and now - k["ticketCheckedAt"] < TICKET_RECHECK:
            e["_ticket_url"], e["_ticket_checked"] = k.get("ticketUrl") or "", k["ticketCheckedAt"]
            continue
        try:
            e["_ticket_url"], e["_ticket_checked"] = E.allevents_ticket_url(e["url"]), now
        except Exception as ex:  # keep the last answer, if any, and try again next run
            print(f"  ! AllEvents ticket link for {e['url']}: {ex}", file=sys.stderr)
        fetched += 1
        time.sleep(delay)
    return fetched


def load(db, docs, source_counts, report, run_start, city=E.DEFAULT_CITY):
    """Upsert one city's documents, mark its long-missing events removed, and record the run.
    Returns the run document."""
    from pymongo import UpdateOne
    ops = [UpdateOne({"_id": d["_id"]},
                     {"$set": {**{k: v for k, v in d.items() if k != "_id"},
                               "status": "active", "lastSeen": run_start, "missedRuns": 0},
                      "$setOnInsert": {"firstSeen": run_start}},
                     upsert=True)
           for d in docs]
    res = db.events.bulk_write(ops, ordered=False) if ops else None

    # the first city's runs from before cities have no `city`
    same_city = {"city": city} if city != E.DEFAULT_CITY else {"city": {"$in": [city, None]}}
    prev = db.runs.find_one({**same_city, "status": {"$ne": "partial"}}, sort=[("startedAt", -1)])
    healthy = prev is None or len(docs) >= HEALTHY_SHARE * prev["total"]
    removed = 0
    if healthy:  # a crawl that mostly failed must not make everything look removed
        # events added by hand (crawler/suggestions.py) aren't any source's, so a crawl not finding them means nothing
        db.events.update_many({**same_city, "status": "active", "lastSeen": {"$lt": run_start},
                               "manual": {"$ne": True}},
                              {"$inc": {"missedRuns": 1}})
        removed = db.events.update_many({**same_city, "status": "active",
                                         "missedRuns": {"$gte": REMOVE_AFTER_MISSED_RUNS}},
                                        {"$set": {"status": "removed"}}).modified_count

    before = {s["source"]: s["count"] for s in (prev or {}).get("sources", [])}
    dropped = sorted(s for s, n in before.items() if n > 0 and source_counts.get(s, 0) == 0 and s not in SPARSE_SOURCES)
    # a source that errored and found nothing is broken (blocked, moved, redesigned), even if it never worked
    errored = {m.group(1) for r in report if (m := FAILED_SOURCE_RE.match(r))}
    failed = sorted(s for s in errored if source_counts.get(s, 0) == 0)
    run = {
        "city": city,
        "startedAt": run_start,
        "finishedAt": datetime.now(timezone.utc),
        # a list, not a {source: count} map: source names may contain dots
        "sources": [{"source": s, "count": n} for s, n in sorted(source_counts.items())],
        "total": len(docs),
        "upserted": res.upserted_count if res else 0,
        "modified": res.modified_count if res else 0,
        "removed": removed,
        "droppedSources": dropped,
        "failedSources": failed,
        "errors": [r.strip().lstrip("! ") for r in report if r.strip().startswith("!")],
        "status": "partial" if not healthy else ("alert" if dropped or failed else "ok"),
    }
    db.runs.insert_one(run)
    return run


def main():
    ap = argparse.ArgumentParser(description="Crawl one city's events and upsert them into MongoDB.")
    ap.add_argument("--city", default=E.DEFAULT_CITY,
                    help=f"a city in shared/cities.json or a requested one (default {E.DEFAULT_CITY})")
    ap.add_argument("--list-cities", action="store_true",
                    help="print the cities to crawl, as JSON (the scheduled crawl's job list), and stop")
    ap.add_argument("--days", type=int, default=30, help="look-ahead window (default 30)")
    ap.add_argument("--pages", type=int, default=2, help="pages per paginated source (default 2)")
    ap.add_argument("--delay", type=float, default=1.5, help="seconds between requests")
    ap.add_argument("--dry-run", action="store_true", help="crawl and print a sample; don't touch the database")
    ap.add_argument("--skip-ticket-links", action="store_true",
                    help="don't fetch AllEvents event pages for their ticket links (a quicker run)")
    args = ap.parse_args()

    uri = os.environ.get("MONGODB_URI")
    if args.list_cities:
        return list_cities(uri)
    if not uri and not args.dry_run:
        sys.exit("MONGODB_URI is not set (or use --dry-run)")
    run_start = datetime.now(timezone.utc)

    client = None
    if uri and not (args.dry_run and args.city in E.CITIES):
        from pymongo import MongoClient
        client = MongoClient(uri, tz_aware=True, appname="wpg-events-crawler")
    try:
        db = client[os.environ.get("MONGODB_DB") or DEFAULT_DB] if client else None
        requested = args.city not in E.CITIES
        if requested:
            doc = db.cityRequests.find_one({"_id": args.city}) if db is not None else None
            if not doc:
                sys.exit(f"{args.city} is neither in shared/cities.json nor a requested city")
            E.CITIES[args.city] = requested_city(doc)
        E.use_city(args.city)
        a = E.build_parser().parse_args(["--city", args.city, "--days", str(args.days), "--pages", str(args.pages),
                                         "--delay", str(args.delay)])
        now = datetime.now(E.LOCAL_TZ)
        end = now + timedelta(days=a.days)
        if args.dry_run:
            db = None  # read the request above, but write nothing
        if db is not None:
            E.SYNOPSES.update(known_synopses(db, run_start))
        print(f"Crawling {E.CITY_NAME}")
        raw, report = E.crawl(a, now, end)
        report.append(f"  Film synopses: {E.SYNOPSIS_STATS['fetched']} fetched, {E.SYNOPSIS_STATS['reused']} reused")
        source_counts = collections.Counter(e["source"] for e in raw)
        selected = E.select_events(raw, a, now, end)
        if not args.skip_ticket_links:
            known = known_ticket_links(db, selected) if db is not None else {}
            fetched = add_ticket_links(selected, known, run_start, a.delay)
            report.append(f"  AllEvents ticket links: {fetched} event pages checked")
        docs = build_docs(selected)
        print("Sources:\n" + "\n".join(report))
        print(f"\n{len(docs)} events to load")
        if db is None:
            if docs:
                print(json.dumps(docs[0], default=str, indent=2, ensure_ascii=False))
            return 0
        run = load(db, docs, source_counts, report, run_start, E.CITY)
        if requested:
            status = mark_requested_city(db, E.CITY, run)
    finally:
        if client:
            client.close()
    print(f"Loaded: {run['upserted']} new, {run['modified']} updated, {run['removed']} marked removed "
          f"(status: {run['status']})")
    if requested:
        # a requested city's sources may well not exist (AllEvents has no page for it): that's an answer, not a failure
        print(f"Requested city: {status} ({run['total']} events; {MIN_EVENTS} needed to go live)")
        return 0
    if run["status"] == "partial":
        print(f"! Only {run['total']} events, under half of the last run; nothing was marked removed.", file=sys.stderr)
        return 3
    if run["status"] == "alert":
        if run["droppedSources"]:
            print("! These sources returned events last run and none this run: " + ", ".join(run["droppedSources"]),
                  file=sys.stderr)
        if run["failedSources"]:
            print("! These sources failed and found nothing: " + ", ".join(run["failedSources"]), file=sys.stderr)
        return 2
    return 0


def list_cities(uri):
    """Print the slugs to crawl as a JSON array. If the requested cities can't be read (no database, or a
    user without access to cityRequests), the configured cities."""
    slugs = cities_to_crawl(None)
    if uri:
        try:
            from pymongo import MongoClient
            client = MongoClient(uri, serverSelectionTimeoutMS=10_000)
            try:
                slugs = cities_to_crawl(client[os.environ.get("MONGODB_DB") or DEFAULT_DB])
            finally:
                client.close()
        except Exception as ex:
            print(f"! Requested cities unavailable ({ex}); crawling the configured ones", file=sys.stderr)
    print(json.dumps(slugs))
    return 0


if __name__ == "__main__":
    sys.exit(main())
