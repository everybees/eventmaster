#!/usr/bin/env python3
"""
suggestions.py — review the events people suggest in the app ("Suggest an event") and list the good ones.

A suggestion is a link (an Instagram post, a ticket page, the organizer's site) and a city, sometimes with a
note. Nothing is public until it's added here. An added event is an ordinary event document with
`manual: true`: the feed shows it like any other, the crawl never marks it removed (it isn't any source's),
and it's deleted 30 days after it ends.

  python3 crawler/suggestions.py list [--city lagos] [--all]
  python3 crawler/suggestions.py draft 3f9a0c12            # writes suggestion-3f9a0c12.json to fill in
  python3 crawler/suggestions.py add suggestion-3f9a0c12.json
  python3 crawler/suggestions.py reject 3f9a0c12
  python3 crawler/suggestions.py remove evt_0123456789abcdef  # an added event that was cancelled

`draft` fills in what the page says about itself (schema.org Event data, which most ticket sites have).
Instagram and Facebook pages are never fetched (Meta doesn't allow it): fill those in from the post.
An event's ID comes from its city, title and date, as for crawled ones, so adding it again with a changed title
or date makes a second event: remove the first. Needs MONGODB_URI (the crawler user) and pymongo.
"""
import argparse, collections, json, os, re, sys, tomllib, urllib.parse
from datetime import datetime, timedelta, timezone
from pathlib import Path

import events as E
import load_to_mongo as L

ROOT = Path(__file__).resolve().parent.parent
LOOK_AHEAD = timedelta(days=366)  # how far ahead an added event may start
FIELDS = ("title", "start", "end", "venue", "address", "price", "currency", "image", "description", "url")
DRAFT_ORDER = (*FIELDS[:7], "category", *FIELDS[7:])
LOCAL_RE = re.compile(r"^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$")
META_HOSTS = re.compile(r"(^|\.)(instagram\.com|instagr\.am|facebook\.com|fb\.com|fb\.me|threads\.net)$")
EXPIRING_IMAGES = re.compile(r"(^|\.)(cdninstagram\.com|fbcdn\.net)$")  # signed links that stop working in days
# how a link's site is named in the app ("via Instagram", "Open on Instagram"); others go by their address
SITE_NAMES = [
    (re.compile(r"(^|\.)(instagram\.com|instagr\.am)$"), "Instagram"),
    (re.compile(r"(^|\.)(facebook\.com|fb\.com|fb\.me)$"), "Facebook"),
    (re.compile(r"(^|\.)(x\.com|twitter\.com)$"), "X"),
    (re.compile(r"(^|\.)tix\.africa$"), "Tix Africa"),
    (re.compile(r"(^|\.)eventbrite\.[a-z.]+$"), "Eventbrite"),
    (re.compile(r"(^|\.)ticketmaster\.[a-z.]+$"), "Ticketmaster"),
    (re.compile(r"(^|\.)allevents\.in$"), "AllEvents"),
    (re.compile(r"(^|\.)beyond30events\.com$"), "Beyond 30"),  # as the crawl names it (events.BEYOND30_SOURCE)
]
HELP = {
    "start": "the city's own time: 2026-12-06T19:00, or 2026-12-06 for a day with no time",
    "end": "the same, or empty; one that runs 2 days or more shows as ongoing",
    "price": "Free, 5000, 5000–20000, or empty when it isn't said",
    "currency": "NGN, CAD…; empty for the city's",
    "category": "empty: worked out from the title, as for crawled events; or one of: "
                + ", ".join([*E.CATEGORIES, "Other"]),
    "image": "a picture's address that keeps working (not an Instagram or Facebook one), or empty",
    "notes": "what the people who suggested it wrote; not stored with the event",
}


def connect():
    uri = os.environ.get("MONGODB_URI")
    if not uri:
        sys.exit("MONGODB_URI is not set")
    from pymongo import MongoClient
    client = MongoClient(uri, tz_aware=True, appname="wpg-events-suggestions")
    return client, client[os.environ.get("MONGODB_DB") or L.DEFAULT_DB]


def use_city(db, slug):
    """As the loader does it: a city in shared/cities.json, or a requested one."""
    if slug not in E.CITIES:
        doc = db.cityRequests.find_one({"_id": slug}) if db is not None else None
        if not doc:
            sys.exit(f"{slug!r} is neither in shared/cities.json nor a requested city")
        E.CITIES[slug] = L.requested_city(doc)
    E.use_city(slug)


def site_name(url):
    host = (urllib.parse.urlsplit(url).hostname or "").removeprefix("www.").removeprefix("m.")
    return next((name for rx, name in SITE_NAMES if rx.search(host)), host)


def local_time(s):
    """A schema.org date ("2026-12-06T19:00:00+01:00") as the city's wall-clock time, the way the crawl reads it."""
    dt = E.parse_dt(s)
    if not dt:
        return ""
    return dt.date().isoformat() if len(s.strip()) == 10 else dt.strftime("%Y-%m-%dT%H:%M")


def page_event(url):
    """(what the page says about the event, or None; a line saying where the draft came from)."""
    if META_HOSTS.search(urllib.parse.urlsplit(url).hostname or ""):
        return None, "Instagram and Facebook pages aren't fetched: fill it in from the post."
    try:
        found = E.scrape_jsonld(url, "")
    except Exception as ex:  # any failure just means typing it in
        return None, f"The page couldn't be read ({ex}): fill it in by hand."
    if not found:
        return None, "The page doesn't describe an event in a way we can read: fill it in by hand."
    e = found[0]
    e["start"], e["end"] = local_time(e["start"]), local_time(e["end"])
    more = f" (it lists {len(found)} events; this is the first)" if len(found) > 1 else ""
    return e, f"Filled in from the page{more}: check it."


def by_link(db, key):
    """Every suggestion of one link, by its key or the key's start."""
    docs = list(db.suggestions.find({"key": {"$regex": "^" + re.escape(key.lower())}}).sort("at", 1))
    if not docs:
        sys.exit(f"No suggestion {key}")
    links = {d["url"] for d in docs}
    if len(links) > 1:
        sys.exit(f"{key} matches {len(links)} links: give more of the key")
    return docs


def listed_as(db, url):
    return db.events.find_one({"url": {"$in": [url, url + "/"]}, "status": "active"}, {"title": 1})


def print_link(db, docs):
    d = docs[0]
    city = collections.Counter(x["city"] for x in docs).most_common(1)[0][0]
    people = f"{len(docs)} {'person' if len(docs) == 1 else 'people'}"
    statuses = "/".join(sorted({x["status"] for x in docs}))
    print(f"  {d['key']}  {d['url']}")
    print(f"            {city} · {people} · first {d['at']:%d %b %H:%M} UTC · {statuses}")
    for x in docs:
        if x["note"]:
            print(f"            “{x['note']}”")
    added = next((x["eventId"] for x in docs if x.get("eventId")), None)
    event = listed_as(db, d["url"])
    if event and event["_id"] != added:
        print(f"            already listed: {event['_id']} “{event['title']}”")
    if added:
        print(f"            added as {added}")


def cmd_list(db, a):
    query = {} if a.all else {"status": "new"}
    if a.city:
        query["city"] = a.city
    links = collections.defaultdict(list)
    for d in db.suggestions.find(query).sort("at", 1):
        links[d["key"]].append(d)
    if not links:
        print("No suggestions." if a.all else "No new suggestions.")
        return
    by_city = collections.defaultdict(list)
    for docs in links.values():
        by_city[docs[0]["city"]].append(docs)
    for city, groups in sorted(by_city.items()):
        print(f"\n{city}: {len(groups)} {'link' if len(groups) == 1 else 'links'}")
        for docs in groups:
            print_link(db, docs)
    print("\nNext:  python3 crawler/suggestions.py draft <key>   (or reject <key>)")


def cmd_draft(db, a):
    docs = by_link(db, a.key)
    url, key = docs[0]["url"], docs[0]["key"]
    city = collections.Counter(d["city"] for d in docs).most_common(1)[0][0]
    use_city(db, city)
    draft = {"suggestion": key, "city": city, **{k: "" for k in DRAFT_ORDER}, "url": url,
             "notes": [d["note"] for d in docs if d["note"]], "help": HELP}
    found, how = page_event(url)
    if found:
        draft.update({k: found[k] for k in FIELDS if k != "url" and found.get(k)})
    out = Path(a.out or f"suggestion-{key}.json")
    out.write_text(json.dumps(draft, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(how)
    print(f"Wrote {out}. Fill in what's missing, then:  python3 crawler/suggestions.py add {out}")


def problems(draft):
    """What's wrong with a filled-in draft, in words."""
    out = []
    text = {k: str(draft.get(k) or "").strip() for k in (*FIELDS, "category")}
    if not text["title"]:
        out.append("title is empty")
    for k in ("start", "end"):
        if (text[k] or k == "start") and not (LOCAL_RE.match(text[k]) and E.parse_dt(text[k])):
            out.append(f"{k} must look like 2026-12-06T19:00, or 2026-12-06")
    if not out and text["end"] and E.parse_dt(text["end"]) < E.parse_dt(text["start"]):
        out.append("end is before start")
    if not text["url"].startswith(("https://", "http://")):
        out.append("url must be the event's page")
    if text["category"] and text["category"] not in [*E.CATEGORIES, "Other"]:
        out.append("category must be empty or one of: " + ", ".join([*E.CATEGORIES, "Other"]))
    image = text["image"]
    if image and not image.startswith(("https://", "http://")):
        out.append("image must be a picture's address, or empty")
    elif image and EXPIRING_IMAGES.search(urllib.parse.urlsplit(image).hostname or ""):
        out.append("Instagram and Facebook picture links stop working within days: leave image empty")
    return out


def event_doc(draft, now):
    """The event's document, built the way the crawl builds one. E.use_city() must be the draft's city."""
    wrong = problems(draft)
    if wrong:
        sys.exit("Not added:\n" + "\n".join(f"  - {p}" for p in wrong))
    e = {k: str(draft.get(k) or "").strip() for k in FIELDS}
    e["source"] = site_name(e["url"])
    a = E.build_parser().parse_args(["--city", E.CITY])
    if not E.wanted(e, a, now, now + LOOK_AHEAD):
        sys.exit("Not added: it has ended, or it starts more than a year from now")
    category = str(draft.get("category") or "").strip()
    if category:
        e["category"] = category
        if category == "Family & Kids" and "family" not in e["tags"]:
            e["tags"].append("family")
    return L.to_doc(e)


def image_note(url):
    """A warning when the picture's site isn't one Netlify's image CDN may fetch from."""
    if not url:
        return ""
    allowed = tomllib.loads((ROOT / "netlify.toml").read_text(encoding="utf-8"))["images"]["remote_images"]
    if any(re.fullmatch(p, url) for p in allowed):
        return ""
    return ("Note: the picture's site isn't in netlify.toml's [images] list, so phones load it from there, full size. "
            "Add the site if you'll use it again.")


def add(db, draft, now=None):
    """Lists a filled-in draft; marks its suggestions added. Returns (the document, whether it was new)."""
    use_city(db, str(draft.get("city") or ""))
    now = now or datetime.now(timezone.utc)
    doc = event_doc(draft, now.astimezone(E.LOCAL_TZ))
    res = db.events.update_one({"_id": doc["_id"]}, {
        "$set": {**{k: v for k, v in doc.items() if k != "_id"},
                 "status": "active", "lastSeen": now, "missedRuns": 0, "manual": True},
        "$setOnInsert": {"firstSeen": now},
    }, upsert=True)
    if draft.get("suggestion"):
        db.suggestions.update_many({"key": draft["suggestion"]},
                                   {"$set": {"status": "added", "eventId": doc["_id"], "reviewedAt": now}})
    return doc, res.upserted_id is not None


def cmd_add(db, a):
    draft = json.loads(Path(a.file).read_text(encoding="utf-8"))
    doc, new = add(db, draft)
    when = doc["startLocal"].replace("T", " ")
    print(f"{'Added' if new else 'Updated'} {doc['_id']}: “{doc['title']}”, {when}, {doc['category']}, in {E.CITY_NAME}.")
    print(f"It's in the feed within about 10 minutes (the CDN's copy), and at /?event={doc['_id']}.")
    if not new:
        print("An event with this ID was already listed (the same title and day): it now has the draft's details.")
    if note := image_note(doc["image"] or ""):
        print(note)


def cmd_reject(db, a):
    docs = by_link(db, a.key)
    db.suggestions.update_many({"key": docs[0]["key"]},
                               {"$set": {"status": "rejected", "reviewedAt": datetime.now(timezone.utc)}})
    print(f"Rejected {docs[0]['url']}")


def cmd_remove(db, a):
    doc = db.events.find_one({"_id": a.event_id}, {"title": 1, "manual": 1})
    if not doc:
        sys.exit(f"No event {a.event_id}")
    if not doc.get("manual"):
        sys.exit("That event comes from a crawl, which would list it again: only events added here can be removed here")
    db.events.update_one({"_id": doc["_id"]}, {"$set": {"status": "removed"}})
    print(f"Removed “{doc['title']}”: it's out of the feed within about 10 minutes")


def build_parser():
    ap = argparse.ArgumentParser(description="Review the events people suggest, and add the good ones.")
    sub = ap.add_subparsers(dest="command", required=True)
    p = sub.add_parser("list", help="new suggestions, by city")
    p.add_argument("--city", help="one city's")
    p.add_argument("--all", action="store_true", help="the reviewed ones too")
    p = sub.add_parser("draft", help="write a link's event to a file to fill in, from its page where it can")
    p.add_argument("key", help="the link's key, from list (its first few characters do)")
    p.add_argument("--out", help="the file (default suggestion-<key>.json)")
    p = sub.add_parser("add", help="list the event in a filled-in draft")
    p.add_argument("file")
    p = sub.add_parser("reject", help="not one to list")
    p.add_argument("key")
    p = sub.add_parser("remove", help="take an added event out of the feed (it was cancelled)")
    p.add_argument("event_id")
    return ap


COMMANDS = {"list": cmd_list, "draft": cmd_draft, "add": cmd_add, "reject": cmd_reject, "remove": cmd_remove}


def main():
    a = build_parser().parse_args()
    client, db = connect()
    try:
        COMMANDS[a.command](db, a)
    finally:
        client.close()


if __name__ == "__main__":
    main()
