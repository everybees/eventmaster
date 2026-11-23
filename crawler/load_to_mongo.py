#!/usr/bin/env python3
"""
load_to_mongo.py — crawl every source (the same crawl as events.py) and upsert the events into MongoDB.

Meant to run on a schedule (.github/workflows/crawl.yml). Each event is one document keyed by its
stable ID, so a re-crawl updates it in place. Events missing from two healthy runs in a row are
marked "removed". Every run writes a `runs` document with per-source counts. The script exits with
status 2 when a source that returned events last run returns none, and 3 when the run found under
half as many events as the last one, so the scheduled job fails and GitHub notifies you.

  MONGODB_URI=mongodb+srv://… python3 crawler/load_to_mongo.py
  python3 crawler/load_to_mongo.py --dry-run      # crawl and print a sample; no database needed

Needs pymongo (pip install -r crawler/requirements.txt), except for --dry-run.
"""
import argparse, collections, json, os, sys
from datetime import datetime, timedelta, timezone

import events as E

DEFAULT_DB = "wpg_events"
REMOVE_AFTER_MISSED_RUNS = 2
HEALTHY_SHARE = 0.5               # a run with under half the last run's events removes nothing
FEED_GRACE = timedelta(hours=6)   # as in events.wanted(): an event stays listed this long after it ends


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
    return {
        "_id": E.stable_id(e),
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
        "price": {"text": e.get("price") or "", "free": True if free else (False if cost == "Paid" else None)},
        "cost": "Free" if free else cost,
        "image": e.get("image") or None,
        "description": E.clean(e.get("description"), limit=1200),
        "url": e["url"],
        "source": e["source"],
        "showtimes": e.get("_showtimes", []),
        "visibleUntil": (last + FEED_GRACE).astimezone(timezone.utc),
        "expireAt": (last + timedelta(days=1)).astimezone(timezone.utc),  # TTL index deletes it then
    }


def build_docs(selected):
    """Documents for every dated event, first one wins if two share an ID."""
    docs = {}
    for e in selected:
        if e["_dt"]:
            d = to_doc(e)
            docs.setdefault(d["_id"], d)
    return list(docs.values())


def load(db, docs, source_counts, report, run_start):
    """Upsert the documents, mark long-missing events removed, and record the run. Returns the run document."""
    from pymongo import UpdateOne
    ops = [UpdateOne({"_id": d["_id"]},
                     {"$set": {**{k: v for k, v in d.items() if k != "_id"},
                               "status": "active", "lastSeen": run_start, "missedRuns": 0},
                      "$setOnInsert": {"firstSeen": run_start}},
                     upsert=True)
           for d in docs]
    res = db.events.bulk_write(ops, ordered=False) if ops else None

    prev = db.runs.find_one({"status": {"$ne": "partial"}}, sort=[("startedAt", -1)])
    healthy = prev is None or len(docs) >= HEALTHY_SHARE * prev["total"]
    removed = 0
    if healthy:  # a crawl that mostly failed must not make everything look removed
        db.events.update_many({"status": "active", "lastSeen": {"$lt": run_start}}, {"$inc": {"missedRuns": 1}})
        removed = db.events.update_many({"status": "active", "missedRuns": {"$gte": REMOVE_AFTER_MISSED_RUNS}},
                                        {"$set": {"status": "removed"}}).modified_count

    before = {s["source"]: s["count"] for s in (prev or {}).get("sources", [])}
    dropped = sorted(s for s, n in before.items() if n > 0 and source_counts.get(s, 0) == 0)
    run = {
        "startedAt": run_start,
        "finishedAt": datetime.now(timezone.utc),
        # a list, not a {source: count} map: source names may contain dots
        "sources": [{"source": s, "count": n} for s, n in sorted(source_counts.items())],
        "total": len(docs),
        "upserted": res.upserted_count if res else 0,
        "modified": res.modified_count if res else 0,
        "removed": removed,
        "droppedSources": dropped,
        "errors": [r.strip().lstrip("! ") for r in report if r.strip().startswith("!")],
        "status": "partial" if not healthy else ("alert" if dropped else "ok"),
    }
    db.runs.insert_one(run)
    return run


def main():
    ap = argparse.ArgumentParser(description="Crawl Winnipeg events and upsert them into MongoDB.")
    ap.add_argument("--days", type=int, default=30, help="look-ahead window (default 30)")
    ap.add_argument("--pages", type=int, default=2, help="pages per paginated source (default 2)")
    ap.add_argument("--delay", type=float, default=1.5, help="seconds between requests")
    ap.add_argument("--dry-run", action="store_true", help="crawl and print a sample; don't touch the database")
    args = ap.parse_args()

    a = E.build_parser().parse_args(["--days", str(args.days), "--pages", str(args.pages), "--delay", str(args.delay)])
    run_start = datetime.now(timezone.utc)
    now = datetime.now(E.LOCAL_TZ)
    end = now + timedelta(days=a.days)
    raw, report = E.crawl(a, now, end)
    source_counts = collections.Counter(e["source"] for e in raw)
    docs = build_docs(E.select_events(raw, a, now, end))
    print("Sources:\n" + "\n".join(report))
    print(f"\n{len(docs)} events to load")

    if args.dry_run:
        if docs:
            print(json.dumps(docs[0], default=str, indent=2, ensure_ascii=False))
        return 0
    uri = os.environ.get("MONGODB_URI")
    if not uri:
        sys.exit("MONGODB_URI is not set (or use --dry-run)")
    from pymongo import MongoClient
    with MongoClient(uri, tz_aware=True, appname="wpg-events-crawler") as client:
        run = load(client[os.environ.get("MONGODB_DB") or DEFAULT_DB], docs, source_counts, report, run_start)
    print(f"Loaded: {run['upserted']} new, {run['modified']} updated, {run['removed']} marked removed "
          f"(status: {run['status']})")
    if run["status"] == "partial":
        print(f"! Only {run['total']} events, under half of the last run; nothing was marked removed.", file=sys.stderr)
        return 3
    if run["status"] == "alert":
        print("! These sources returned events last run and none this run: " + ", ".join(run["droppedSources"]),
              file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
