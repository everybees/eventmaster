#!/usr/bin/env python3
"""
events.py — pull one city's upcoming events from several sources into one list.

Cities and their sources are in shared/cities.json (Winnipeg is the default). For each city:
  - AllEvents.in (aggregates many public Facebook events)
  - Eventbrite (public discovery pages), only with CRAWL_EVENTBRITE=1: it refuses data-centre addresses,
    so it works from a home connection but not from GitHub Actions
  - Movies & film: AllEvents film pages, and CinemaClock for showtimes at the city's cinemas
  - Ticketmaster Discovery API (optional, free key: TICKETMASTER_API_KEY)
  - the city's own extra sources, e.g. Tourism Winnipeg and the Cinematheque
  - Any extra page you pass with --url (works on most sites using schema.org Event markup)

Standard library only — no pip installs needed.

Usage:
  python3 crawler/events.py                      # Winnipeg, next 30 days
  python3 crawler/events.py --city calgary
  python3 crawler/events.py --days 7 --pages 3
  python3 crawler/events.py --search "afrobeats"
  python3 crawler/events.py --category music --category arts   # matches category names or tags
  python3 crawler/events.py --category holiday                 # tags: holiday, family, ongoing
  TICKETMASTER_API_KEY=xxxx python3 crawler/events.py
  CRAWL_EVENTBRITE=1 python3 crawler/events.py
  python3 crawler/events.py --category movies
  python3 crawler/events.py --url https://some-venue.ca/events
"""
import argparse, collections, csv, hashlib, html, json, os, re, sys, time, unicodedata
import urllib.request, urllib.parse
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")

# Every city's settings; use_city() (at the bottom of the file) points the crawler at one of them.
CITIES = json.loads((Path(__file__).resolve().parent.parent / "shared" / "cities.json").read_text(encoding="utf-8"))
DEFAULT_CITY = next(iter(CITIES))  # the first city (Winnipeg): its event IDs predate cities (see stable_id)
# Set by use_city(): the city's slug and name, its time zone, its JSON-LD sources (name -> URL
# templates; {page} is replaced for paginated sources), venues for sources whose markup leaves them
# out, its CinemaClock theatres, its Ticketmaster search, and its venue categorization rules.
CITY = CITY_NAME = ""
LOCAL_TZ = timezone.utc
JSONLD_SOURCES, SOURCE_VENUES, CINEMACLOCK_THEATRES, TICKETMASTER_PLACE, CITY_VENUE_RULES = {}, {}, [], {}, []
SILVERBIRD_CINEMAS = []  # [{"slug", "name", "address"}]: the city's Silverbird cinemas (Nigeria)
# "Otium - 11/22/26 @ 3:00 pm": the Cinematheque puts each showtime in the title
SHOWTIME_SUFFIX_RE = re.compile(r" - \d{1,2}/\d{1,2}/\d{2,4} ?@ ?\d{1,2}:\d{2} ?[ap]m$", re.I)  # on clean()ed titles


def fetch(url, timeout=25):
    return fetch_final(url, timeout)[0]


def fetch_final(url, timeout=25):
    """(page, the URL it ended up at after any redirects)."""
    # listings link to addresses like /matambú-la-cumbia; escape anything that isn't ASCII
    url = urllib.parse.quote(url, safe=":/?#[]@!$&'()*+,;=%~")
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "en-CA,en"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode(r.headers.get_content_charset() or "utf-8", "replace"), r.geturl()


def same_place(url, final):
    """Whether a redirect stayed on the page asked for. AllEvents sends a city it has no page for to its
    worldwide /events page (allevents.in/abeokuta -> /events), whose events aren't that city's."""
    first = lambda u: urllib.parse.urlsplit(u).path.strip("/").split("/")[0].lower()
    return first(url) == first(final)


TAG_RE = re.compile(r"<[^>]+>")

def norm(s):
    """Search key: "St. John's" -> "st johns", "Montréal" -> "montreal" (as load_places.py and the API)."""
    s = "".join(ch for ch in unicodedata.normalize("NFKD", s or "") if not unicodedata.combining(ch)).lower()
    s = re.sub(r"['’`]", "", s)
    return re.sub(r"[^a-z0-9]+", " ", s).strip()


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

def image_url(v):
    """schema.org image: a URL, a list of them, or an ImageObject."""
    v = first(v)
    if isinstance(v, dict):
        v = v.get("url") or v.get("contentUrl")
    return v if isinstance(v, str) and v.startswith("http") else ""

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
    price, currency = "", ""
    if isinstance(offers, dict):
        currency = offers.get("priceCurrency") or ""
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
        "title": SHOWTIME_SUFFIX_RE.sub("", clean(ev.get("name"))),
        "start": ev.get("startDate", ""),
        "end": ev.get("endDate", ""),
        "venue": clean(venue),
        "address": clean(addr),
        "price": price,
        "currency": currency if re.fullmatch(r"[A-Z]{3}", str(currency)) else "",
        "url": first(ev.get("url")) or "",
        "source": source,
        "description": clean(ev.get("description")),
        "image": image_url(ev.get("image")),
    }

def scrape_jsonld(url, source):
    out = []
    page, final = fetch_final(url)
    if "allevents.in" in url and not same_place(url, final):
        return out  # AllEvents has no page for this city and redirected elsewhere
    for block in LDJSON_RE.findall(page):
        try:
            data = json.loads(block.strip())
        except json.JSONDecodeError:
            continue
        out += [norm_ld(e, source) for e in iter_ld_events(data)]
    for e in out:
        if not e["venue"] and source in SOURCE_VENUES:
            e["venue"], e["address"] = SOURCE_VENUES[source]
    return out


# ---------- Ticketmaster Discovery API ----------
def ticketmaster(start, end, keyword=None):
    key = os.environ.get("TICKETMASTER_API_KEY")
    if not key:
        return []
    params = {
        "apikey": key, **TICKETMASTER_PLACE, "size": 200, "sort": "date,asc",
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
        # widest 16:9 image, else the widest of any shape
        imgs = sorted(e.get("images") or [], key=lambda i: (i.get("ratio") == "16_9", i.get("width") or 0))
        out.append({
            "title": e.get("name", ""),
            "start": d.get("dateTime") or d.get("localDate", ""),
            "end": "",
            "venue": v.get("name", ""),
            "address": (v.get("address") or {}).get("line1", ""),
            "price": f"{pr.get('min','')}–{pr.get('max','')}" if pr else "",
            "currency": pr.get("currency", ""),
            "url": e.get("url", ""),
            "source": "Ticketmaster",
            "description": "",
            "image": imgs[-1].get("url", "") if imgs else "",
            "category_hint": TM_SEGMENTS.get(segment),
        })
    return out


# ---------- CinemaClock: showtimes at the city's cinemas ----------
# Cineplex's own site is off limits: its robots.txt disallows every crawler but search engines,
# and its showtimes come from a private API. CinemaClock lists the same showtimes (plus Landmark
# and the independents) and allows crawling.
CINEMACLOCK = "https://www.cinemaclock.com"
CC_BLOCK_RE = re.compile(r'<div id="moviecin[^"]*" class="showtimeblock')
CC_TITLE_RE = re.compile(r"<h3 class='movietitle[^']*'[^>]*><a[^>]*href='(/movies/[^']+)'>(.*?)</a>")
CC_POSTER_RE = re.compile(r"data-src='/images/posters/140x210(/[^']+)'")
CC_INFO_RE = re.compile(r"<p class='moviegenre'>(.*?)</p>", re.S)
CC_RATING_RE = re.compile(r"<span class='rtMB'>([^<]+)</span>")
CC_CAST_RE = re.compile(r"<span class='avec'>(.*?)</span>")
CC_GROUP_RE = re.compile(r'<div data-earliest-date="(\d{8})"')
CC_FORMAT_RE = re.compile(r'<p class="timesalso">([^<]*)<')
CC_DAY_RE = re.compile(r'<span class="timesdate">([A-Z][a-z]{2}) (\d{1,2})</span></u><i>(.*?)</i>', re.S)
CC_TIME_RE = re.compile(r'data-time="(\d{1,2})(\d{2})"')
CC_SHOWING_RE = re.compile(r'<span\b([^>]*\bdata-time="\d{3,4}"[^>]*)>')
CC_TIX_RE = re.compile(r'\bid="(tix\d+)"')  # bookable showing: /buy-tickets/<id> redirects to the cinema's checkout
CC_SYNOPSIS_RE = re.compile(r'<p id="synopsis"[^>]*>(.*?)</p>', re.S)
MONTHS = {m: i for i, m in enumerate(
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], 1)}
FORMATS = ("IMAX", "ScreenX", "UltraAVX", "D-BOX", "4DX", "VIP", "3D")

def hm(h, m):
    return datetime(2000, 1, 1, h % 24, m).strftime("%I:%M %p").lstrip("0")

def cc_showings(block):
    """{date: {(hour, minute): ticket link or ""}} and the screen formats, from one movie's block."""
    shows, formats = {}, set()
    parts = CC_GROUP_RE.split(block)  # [before, yyyymmdd, group, yyyymmdd, group, ...]
    for earliest, grp in zip(parts[1::2], parts[2::2]):
        year, first_month = int(earliest[:4]), int(earliest[4:6])
        fmt = CC_FORMAT_RE.search(grp)
        fmt = clean(fmt.group(1)) if fmt else ""
        formats.update(f for f in FORMATS if f in fmt)
        if "subt" in fmt:
            formats.add("subtitled")
        for mon, day, inner in CC_DAY_RE.findall(grp):
            month = MONTHS[mon]
            date = datetime(year + (month < first_month), month, int(day)).date()  # Dec → Jan rolls the year
            day = shows.setdefault(date, {})
            for attrs in CC_SHOWING_RE.findall(inner):
                h, m = CC_TIME_RE.search(attrs).groups()
                tix = CC_TIX_RE.search(attrs)
                day[(int(h), int(m))] = day.get((int(h), int(m))) or (f"{CINEMACLOCK}/buy-tickets/{tix.group(1)}" if tix else "")
    return shows, formats

def cc_theatre(slug):
    """One cinema's name, street address and movies (with their showings)."""
    page = fetch(f"{CINEMACLOCK}/movie-theaters/{slug}")
    name, addr = slug.replace("-", " ").title(), ""
    for block in LDJSON_RE.findall(page):
        try:
            d = json.loads(block.strip())
        except json.JSONDecodeError:
            continue
        if isinstance(d, dict) and d.get("@type") == "MovieTheater":
            name, addr = d.get("name") or name, (d.get("address") or {}).get("streetAddress", "")
    starts = [m.start() for m in CC_BLOCK_RE.finditer(page)] + [len(page)]
    movies = []
    for a, b in zip(starts, starts[1:]):
        blk = page[a:b]
        t = CC_TITLE_RE.search(blk)
        if not t:
            continue
        info = CC_INFO_RE.search(blk)
        info = info.group(1) if info else ""
        rating, cast, poster = CC_RATING_RE.search(info), CC_CAST_RE.search(info), CC_POSTER_RE.search(blk)
        shows, formats = cc_showings(blk)
        movies.append({
            "path": t.group(1), "title": clean(t.group(2)), "shows": shows, "formats": formats,
            # runtime, genre, weeks out: what is left once ratings, cast and comments are removed
            "info": clean(re.sub(r"<span class='rt[A-Z]+'>[^<]*</span>|<span class='avec'>.*?</span>|<!--.*?-->",
                                 " ", info)),
            "rating": clean(rating.group(1)) if rating else "",
            "cast": clean(cast.group(1)) if cast else "",
            "poster": f"{CINEMACLOCK}/images/posters/1000x1500{poster.group(1)}" if poster else "",
            "family": bool(re.search(r"class='movieblock[^']*\bgen(fam|ani)\b", blk)),
        })
    return name, addr, movies

def cinemaclock(delay):
    """One row per film now showing, with the next day's times at each cinema showing it."""
    films = {}
    for slug in CINEMACLOCK_THEATRES:
        try:
            name, addr, movies = cc_theatre(slug)
        except Exception as ex:
            print(f"  ! CinemaClock {slug}: {ex}", file=sys.stderr)
            continue
        finally:
            time.sleep(delay)
        for m in movies:
            f = films.setdefault(m["path"], dict(m, cinemas={}, formats=set()))
            f["formats"] |= m["formats"]
            if m["shows"]:
                f["cinemas"][name] = (addr, m["shows"])
    rows = []
    for path, f in films.items():
        if f["cinemas"]:
            rows.append(film_row(CINEMACLOCK + path, "CinemaClock (cinema showtimes)", f,
                                 *film_synopsis(CINEMACLOCK + path, delay)))
    return rows

# Film synopses barely change and the same film plays in every city, so load_to_mongo.py fills this
# with the ones already stored ({film page URL: (synopsis, when it was fetched)}) and only new or
# week-old ones are fetched.
SYNOPSES = {}
SYNOPSIS_STATS = collections.Counter()  # "reused" / "fetched", for the run's report

def film_synopsis(url, delay):
    """(synopsis, when fetched) for a film: from SYNOPSES, else from its page (when fetched is None, it failed)."""
    if url in SYNOPSES:
        SYNOPSIS_STATS["reused"] += 1
        return SYNOPSES[url]
    SYNOPSIS_STATS["fetched"] += 1
    text = page_synopsis(url)
    time.sleep(delay)
    if text is None:
        return "", None
    SYNOPSES[url] = (text, datetime.now(timezone.utc))
    return SYNOPSES[url]

OG_DESCRIPTION_RE = re.compile(r'<meta property="og:description" content="([^"]*)"')
SB_NOTE_RE = re.compile(r"\s*\*?\s*NB:.*$", re.I | re.S)  # "*NB: Showtime is subject to change"

def page_synopsis(url):
    """A film's synopsis, from its own page on CinemaClock or Silverbird. None when the page didn't load."""
    try:
        page = fetch(url)
    except Exception:
        return None
    if url.startswith(CINEMACLOCK):
        s = CC_SYNOPSIS_RE.search(page)
        return clean(s.group(1)) if s else ""
    s = OG_DESCRIPTION_RE.search(page)
    return SB_NOTE_RE.sub("", clean(s.group(1))) if s else ""

def film_row(url, source, f, synopsis, synopsis_checked=None):
    """One film's row: its cinemas' showings, merged across cinemas (CinemaClock or Silverbird)."""
    cinemas = sorted(f["cinemas"])
    dates = sorted(d for _, shows in f["cinemas"].values() for d in shows)
    nxt = []
    for c in cinemas:
        shows = f["cinemas"][c][1]
        day = min(shows)
        nxt.append(f"{c} ({day:%a %b} {day.day}): " + ", ".join(hm(h, m) for h, m in sorted(shows[day])))
    details = " · ".join(filter(None, [f["info"], f"Rated {f['rating']}" if f["rating"] else "",
                                       ", ".join(sorted(f["formats"])), f"With {f['cast']}" if f["cast"] else ""]))
    return {
        "title": f["title"],
        "start": dates[0].isoformat(),
        "end": dates[-1].isoformat() if dates[-1] > dates[0] else "",
        "venue": cinemas[0] if len(cinemas) == 1 else f"{len(cinemas)} cinemas",
        "address": f["cinemas"][cinemas[0]][0] if len(cinemas) == 1 else ", ".join(cinemas),
        "price": "",
        "url": url,
        "source": source,
        "_film": True,  # keyed by its page, not its title and date (see stable_id)
        "description": f"{details}. {synopsis}" if synopsis else details,
        "image": f["poster"],
        "category_hint": "Movies & Film",
        "tag_hints": ["family"] if f["family"] else [],
        "showtimes": " | ".join(nxt),  # each cinema's next day with showings
        "_synopsis": synopsis, "_synopsis_checked": synopsis_checked,
        # the whole week, structured, for the database
        "_showtimes": [{"cinema": c, "address": f["cinemas"][c][0], "date": d.isoformat(),
                        "times": [f"{h % 24:02d}:{m:02d}" for h, m in sorted(f["cinemas"][c][1][d])],
                        "tickets": [link for _, link in sorted(f["cinemas"][c][1][d].items())]}
                       for c in cinemas for d in sorted(f["cinemas"][c][1])],
    }


# ---------- Silverbird Cinemas (Nigeria): the week's showtimes on each cinema's page ----------
# Their pages list each film with its times for the cinema week (Friday to Thursday), each time linking
# to its booking page. robots.txt allows crawling (content signals: search=yes).
SILVERBIRD = "https://silverbirdcinemas.com"
SB_FILM_RE = re.compile(r'class="entry-title"><a href="([^"]+)">(.*?)</a>', re.S)
SB_DAY_RE = re.compile(r"<strong>([A-Z/]+):\s*</strong></span>\s*<strong>(.*?)</strong>", re.S)
SB_TIME_RE = re.compile(r'(?:<a href=\s*"([^"]+)"[^>]*>\s*)?\b(\d{1,2}):(\d{2})\s*([ap]m)\b(?:\s*\(([^)]+)\))?', re.I)
SB_RELEASE_RE = re.compile(r"<span>Release:</span>\s*([A-Z][a-z]{2} \d{1,2}, \d{4})")
SB_RUNTIME_RE = re.compile(r'class="entry-date">.*?</i>\s*([^<]+)</div>', re.S)
SB_GENRE_RE = re.compile(r'/genre/[^"]+/">([^<]+)</a>')
SB_LANGUAGE_RE = re.compile(r"<span>Language:</span>\s*([^<]+)")
SB_POSTER_RE = re.compile(r'<img[^>]+src="([^"]+)"')
SB_NOT_GENRES = {"Now Showing", "Coming Soon", "Slider"}
SB_WEEKDAY = {"FRI": 0, "SAT": 1, "SUN": 2, "MON": 3, "TUE": 4, "TUES": 4, "WED": 5, "THU": 6, "THUR": 6, "THURS": 6}

def sb_runtime(text):
    """"02 hours 38 minutes" -> "2h 38m"."""
    h = re.search(r"(\d+)\s*hour", text)
    m = re.search(r"(\d+)\s*min", text)
    return " ".join(filter(None, [f"{int(h.group(1))}h" if h else "", f"{int(m.group(1))}m" if m and int(m.group(1)) else ""]))

def sb_cinema(slug, today):
    """The films on one Silverbird cinema's page: [{url, title, shows: {date: {(h, m): booking link}}, …}]."""
    page = fetch(f"{SILVERBIRD}/cinema/{slug}/")
    films = []
    for block in page.split('<article class="entry-item">')[1:]:
        block = block.split("</article>")[0]
        t = SB_FILM_RE.search(block)
        if not t:
            continue
        rel = SB_RELEASE_RE.search(block)
        release = datetime.strptime(rel.group(1), "%b %d, %Y").date() if rel else None
        # the weekdays are those of the film's cinema week: this one, or its opening week if it isn't out yet
        start = max(today, release) if release else today
        friday = start - timedelta(days=(start.weekday() - 4) % 7)
        shows, formats = {}, set()
        for days, times in SB_DAY_RE.findall(block):
            for day in days.split("/"):
                if day not in SB_WEEKDAY:
                    continue
                date = friday + timedelta(days=SB_WEEKDAY[day])
                if date < today or (release and date < release):
                    continue
                for link, h, m, ampm, fmt in SB_TIME_RE.findall(times):
                    when = (int(h) % 12 + (12 if ampm.lower() == "pm" else 0), int(m))
                    shows.setdefault(date, {})[when] = shows.get(date, {}).get(when) or link.strip()
                    if fmt:
                        formats.add(clean(fmt))
        genres = [g for g in (clean(x) for x in SB_GENRE_RE.findall(block)) if g not in SB_NOT_GENRES]
        runtime, language = SB_RUNTIME_RE.search(block), SB_LANGUAGE_RE.search(block)
        poster = SB_POSTER_RE.search(block)
        films.append({
            "url": t.group(1),
            "title": clean(re.sub(r"\s*\(Release [^)]*\)\s*$", "", clean(t.group(2)))),
            "shows": shows, "formats": formats,
            "info": " · ".join(filter(None, [sb_runtime(runtime.group(1)) if runtime else "", ", ".join(genres),
                                             clean(language.group(1)) if language else ""])),
            "rating": "", "cast": "",
            # the full-size poster: the thumbnail's name without its "-164x220" size
            "poster": re.sub(r"-\d+x\d+(\.\w+)$", r"\1", poster.group(1)) if poster else "",
            "family": any(g in ("Family", "Animation") for g in genres),
        })
    return films

def silverbird(delay):
    """One row per film now showing at the city's Silverbird cinemas, as cinemaclock() does."""
    today = datetime.now(LOCAL_TZ).date()
    films = {}
    for cinema in SILVERBIRD_CINEMAS:
        try:
            movies = sb_cinema(cinema["slug"], today)
        except Exception as ex:
            print(f"  ! Silverbird {cinema['slug']}: {ex}", file=sys.stderr)
            continue
        finally:
            time.sleep(delay)
        for m in movies:
            f = films.setdefault(m["url"], dict(m, cinemas={}, formats=set()))
            f["formats"] |= m["formats"]
            if m["shows"]:
                f["cinemas"][cinema["name"]] = (cinema.get("address", ""), m["shows"])
    return [film_row(url, "Silverbird Cinemas", f, *film_synopsis(url, delay))
            for url, f in films.items() if f["cinemas"]]


# ---------- AllEvents: the real seller behind a listing ----------
AE_TICKET_RE = re.compile(r"\['external_ticket_url'\]\s*=\s*\"((?:[^\"\\]|\\.)*)\"")
TRACKING_PARAMS_RE = re.compile(r"^(aff|ref|utm_\w+)$", re.I)

def unwrap_tracking(url):
    """An affiliate deep link (https://tracker/c/1/2/3?u=<seller URL>) -> the seller's own URL,
    without referral parameters, so the click isn't credited to whoever wrapped it."""
    q = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)
    inner = next((v[0] for k in ("u", "url") for v in [q.get(k)] if v and v[0].startswith(("https://", "http://"))), url)
    parts = urllib.parse.urlsplit(inner)
    query = [(k, v) for k, v in urllib.parse.parse_qsl(parts.query) if not TRACKING_PARAMS_RE.match(k)]
    return urllib.parse.urlunsplit(parts._replace(query=urllib.parse.urlencode(query)))

def allevents_ticket_url(page_url):
    """Where an AllEvents listing sends people for tickets (Ticketmaster, Eventbrite, the organizer…),
    or "" when it doesn't. It's only in the event's own page, not in the listing pages."""
    m = AE_TICKET_RE.search(fetch(page_url))
    url = json.loads(f'"{m.group(1)}"') if m else ""  # a JavaScript string: "https:\/\/…"
    return unwrap_tracking(url) if url.startswith(("https://", "http://")) else ""


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
    if dt.tzinfo and not dt.utcoffset():
        return dt.astimezone(LOCAL_TZ)  # UTC, e.g. Ticketmaster
    # Local listings: keep the wall-clock time as written. Sources disagree on Winnipeg's offset
    # since Manitoba stopped changing clocks in Nov 2026 (Eventbrite still sends -06:00,
    # Burton Cummings and the Cinematheque -05:00), and converting would shift some by an hour.
    return dt.replace(tzinfo=LOCAL_TZ)

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

def stable_id(e):
    """The same event gets the same ID on every run, whichever source happened to list it first,
    so saved events and interaction history survive re-crawls. Films are keyed by their CinemaClock
    or Silverbird page, exhibitions and other ongoing runs by title, everything else by title + date, and all of
    them by city (the same film plays in every city), except in the first city, whose IDs came first."""
    if e.get("_film") or e.get("source", "").startswith("CinemaClock"):
        key = e["url"]
    else:
        title, date = dedupe_key(e)
        key = f"{title}|{'ongoing' if 'ongoing' in e.get('tags', ()) else date}"
    if CITY != DEFAULT_CITY:
        key = f"{CITY}|{key}"
    return "evt_" + hashlib.sha1(key.encode("utf-8")).hexdigest()[:16]


# ---------- categorization ----------
def _rx(p):
    return re.compile(p, re.I)

# Checked against the title in this order and the first hit wins, so order matters:
# "Kids STEM Workshop" must reach Family before Professional, "Sustainability Tour at The Leaf"
# Exhibitions before Music ("tour"), and "Holiday Market" Markets before Nightlife.
CATEGORY_RULES = [
    ("Sports & Outdoors", _rx(r"\bvs\.?\b|\bversus\b|\b(jets|moose|bombers|valour|goldeyes)\b|fat bike|"
                              r"\b(run|marathon|5k|10k)\b|hockey|curling|\bski(ing)?\b")),
    # before Social ("Movie Night"), Family (kids' matinees) and Food ("Dinner and a Movie")
    ("Movies & Film", _rx(r"\b(film|movie)s?\b|фільм|cinema|\bscreenings?\b|matinee|double feature|"
                          r"feature night|documentary|\b4k\b|restoration|\bimax\b")),
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
                           r"nutcracker|poetry|cirque|circus|aerial")),
    ("Community & Fundraisers", _rx(r"fundrais|['’]s social\b|\bgala\b|\bball\b|anniversary|parade|posada|"
                                    r"charity|\bbenefit\b|foundation|celebration|pow ?wow")),
    ("Nightlife & Parties", _rx(r"part(y|ies)|\bbash\b|takeover|nightlife|club night|extravaganza|\brave\b|"
                                r"karaoke|\bnye\b|(bar|pub) crawl")),
    ("Food & Drink", _rx(r"cocktail|brunch|\blunch(eon)?\b|dinner|tasting|\bwine\b|\bbeer\b|whiske?y|distillery|cooking|"
                         r"culinary|\bchef\b")),
]
# Fallback when the title says nothing; only venues that mostly host one kind of event. Each city
# adds its own named venues (venueRules in shared/cities.json), which are tried first.
VENUE_RULES = [
    ("Movies & Film", _rx(r"cinema|cinematheque|imax|cineplex")),
    ("Music & Concerts", _rx(r"concert hall")),
    ("Nightlife & Parties", _rx(r"nightlife")),
    ("Arts & Theatre", _rx(r"theat(re|er)|arts cent|playhouse")),
    ("Exhibitions & Attractions", _rx(r"art gallery|museum")),
]
TM_SEGMENTS = {"Music": "Music & Concerts", "Sports": "Sports & Outdoors", "Arts & Theatre": "Arts & Theatre",
               "Film": "Movies & Film", "Family": "Family & Kids"}
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
           or next((c for c, rx in CITY_VENUE_RULES + VENUE_RULES if rx.search(e["venue"])), None))
    if not cat and desc:
        # descriptions are noisy, so score every category instead of taking the first hit
        hits, _, best = max((len(rx.findall(desc)), -i, c) for i, (c, rx) in enumerate(CATEGORY_RULES))
        cat = best if hits else None
    cat = cat or "Other"
    tags = []
    if HOLIDAY_RE.search(title):
        tags.append("holiday")
    if cat == "Family & Kids" or FAMILY_RE.search(title) or "family" in e.get("tag_hints", ()):
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
        if len((e["end"] if e["_end"] else e["start"]).strip()) == 10:
            last += timedelta(days=1)  # a bare date lasts all day, rather than ending at midnight
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
        elif e["_dt"] and seen[k]["_dt"] and e["_dt"] != seen[k]["_dt"]:
            # same title, same day, another time: one more showing (e.g. a film at 3 and 7 pm)
            kept = seen[k]
            kept["_times"] = sorted(set(kept.get("_times", [kept["_dt"]]) + [e["_dt"]]))
            kept["_dt"] = kept["_times"][0]
    # ongoing events that began before today sort as today
    final.sort(key=lambda e: (max(e["_dt"].astimezone(LOCAL_TZ).date(), now.date()), e["_dt"])
               if e["_dt"] else (end.date(), end))
    return final


def scrape_sources(sources, max_pages, delay):
    """Fetch every JSON-LD source page; returns (events, report lines)."""
    events, report = [], []
    for name, templates in sources.items():
        got = 0
        for tpl in templates:
            for p in (range(1, max_pages + 1) if "{page}" in tpl else [1]):
                url = tpl.format(page=p)
                try:
                    batch = scrape_jsonld(url, name)
                except Exception as ex:
                    report.append(f"  ! {name}: {url} -> {ex}")
                    break
                events += batch
                got += len(batch)
                time.sleep(delay)
                if not batch:
                    break
        report.append(f"  {name}: {got} found")
    return events, report


def build_parser():
    ap = argparse.ArgumentParser(description="Aggregate a city's events.")
    ap.add_argument("--city", choices=sorted(CITIES), default=DEFAULT_CITY, help=f"default {DEFAULT_CITY}")
    ap.add_argument("--days", type=int, default=30, help="look-ahead window (default 30)")
    ap.add_argument("--pages", type=int, default=2, help="pages per paginated source (default 2)")
    ap.add_argument("--search", help="only keep events whose title/venue contains this text")
    ap.add_argument("--cost", choices=["free", "paid"], help="only keep free or paid events")
    ap.add_argument("--category", action="append", default=[],
                    help="only keep events whose category or tag contains this text (repeatable). "
                         "Categories: " + ", ".join(CATEGORIES) + ", Other. "
                         "Tags: holiday, family, ongoing")
    ap.add_argument("--url", action="append", default=[], help="extra page with schema.org events")
    ap.add_argument("--out", help="output file prefix (default: <city>_events)")
    ap.add_argument("--delay", type=float, default=1.5, help="seconds between requests")
    return ap


def crawl(a, now, end):
    """Fetch every source; returns (raw events, report lines). Shared with load_to_mongo.py."""
    sources = dict(JSONLD_SOURCES)
    for u in a.url:
        sources[urllib.parse.urlparse(u).netloc] = [u]

    events, report = scrape_sources(sources, a.pages, a.delay)

    # sources that aren't schema.org pages; a source with an env var needs a free key
    for label, env, fetch_api in (("Ticketmaster", "TICKETMASTER_API_KEY", lambda: ticketmaster(now, end, a.search)),
                                  ("CinemaClock showtimes", None, lambda: cinemaclock(a.delay)),
                                  ("Silverbird showtimes", None, lambda: silverbird(a.delay))):
        if ((label == "Ticketmaster" and not TICKETMASTER_PLACE) or (label.startswith("CinemaClock") and not CINEMACLOCK_THEATRES)
                or (label.startswith("Silverbird") and not SILVERBIRD_CINEMAS)):
            continue  # not in this city (Ticketmaster doesn't sell there; CinemaClock is Canada only; Silverbird Nigeria)
        if env and not os.environ.get(env):
            report.append(f"  {label}: skipped (set {env})")
            continue
        try:
            got = fetch_api()
            events += got
            report.append(f"  {label}: {len(got)} found")
        except Exception as ex:
            report.append(f"  ! {label} -> {ex}")
    return events, report


def use_city(slug):
    """Point every city setting above at one city in shared/cities.json. A process crawls one city."""
    global CITY, CITY_NAME, LOCAL_TZ, JSONLD_SOURCES, SOURCE_VENUES, CINEMACLOCK_THEATRES, TICKETMASTER_PLACE
    global CITY_VENUE_RULES, SILVERBIRD_CINEMAS
    c = CITIES[slug]
    k = c["crawl"]
    eb, ae = k.get("eventbrite"), k["allevents"]
    CITY, CITY_NAME, LOCAL_TZ = slug, c["name"], ZoneInfo(c["timezone"])
    # AllEvents' usual pages, unless the city lists its own (in Lagos and Abuja only the city's home page
    # carries the events' data)
    JSONLD_SOURCES = k.get("allEventsPages") or {
        "AllEvents (incl. Facebook events)": [f"https://allevents.in/{ae}/all?page={{page}}"],
        # film screenings; the general page above misses most of them
        "AllEvents (movies & film)": [f"https://allevents.in/{ae}/movies?page={{page}}",
                                      f"https://allevents.in/{ae}/film?page={{page}}"],
    }
    JSONLD_SOURCES = {**JSONLD_SOURCES, **k.get("sources", {})}
    # Eventbrite refuses requests from data centres (GitHub's runners get "405 Not Allowed"), so it's off
    # unless asked for, e.g. on a crawl from a home connection: CRAWL_EVENTBRITE=1
    if eb and os.environ.get("CRAWL_EVENTBRITE") == "1":
        site = "www.eventbrite.ca" if c["country"] == "CA" else "www.eventbrite.com"
        JSONLD_SOURCES = {
            "Eventbrite": [f"https://{site}/d/{eb}/all-events/?page={{page}}"],
            "Eventbrite (film)": [f"https://{site}/d/{eb}/film-and-media--events/?page={{page}}"],
            **JSONLD_SOURCES,
        }
    SOURCE_VENUES = {name: tuple(v) for name, v in k.get("sourceVenues", {}).items()}
    CINEMACLOCK_THEATRES = list(k.get("cinemaclock", []))
    SILVERBIRD_CINEMAS = list(k.get("silverbird", []))
    TICKETMASTER_PLACE = dict(k.get("ticketmaster") or {})
    CITY_VENUE_RULES = [(cat, _rx(p)) for cat, p in k.get("venueRules", {}).items()]
    unknown = {cat for cat, _ in CITY_VENUE_RULES} - set(CATEGORIES)
    assert not unknown, f"{slug}: venueRules use unknown categories {unknown}"


use_city(DEFAULT_CITY)


def main():
    a = build_parser().parse_args()
    use_city(a.city)
    a.out = a.out or f"{a.city}_events"
    now = datetime.now(LOCAL_TZ)
    end = now + timedelta(days=a.days)
    events, report = crawl(a, now, end)
    final = select_events(events, a, now, end)

    fields = ["id", "date", "until", "time", "category", "tags", "title", "cost", "price", "venue", "address",
              "source", "url", "image", "showtimes", "description"]
    rows = []
    for e in final:
        dt = e["_dt"].astimezone(LOCAL_TZ) if e["_dt"] else None
        until = e["_end"].astimezone(LOCAL_TZ) if "ongoing" in e["tags"] else None
        times = [t.astimezone(LOCAL_TZ) for t in e.get("_times", [e["_dt"]] if e["_dt"] else [])]
        rows.append({
            "id": stable_id(e),
            "date": dt.strftime("%a %Y-%m-%d") if dt else "",
            "until": until.strftime("%a %Y-%m-%d") if until else "",
            "time": ", ".join(t.strftime("%I:%M %p").lstrip("0") for t in times if t.hour or t.minute),
            "category": e["category"],
            "tags": ";".join(e["tags"]),
            "cost": cost_type(e),
            **{f: e[f] for f in ("title", "venue", "address", "price", "source", "url")},
            "image": e.get("image", ""),
            "showtimes": e.get("showtimes", ""),
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
        print(f"{r['date']} {r['time'][:8]:>8}  {r['cost']:<7}  {r['category'][:22]:<22}  "
              f"{r['title'][:50]:<50}  {r['venue'][:24]}")
    counts = collections.Counter(r["category"] for r in rows)
    print("\nBy category: " + ", ".join(f"{c} ({n})" for c, n in counts.most_common()))
    print(f"\nSaved {a.out}.csv and {a.out}.json")


if __name__ == "__main__":
    sys.exit(main())
