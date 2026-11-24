"""Tests for load_to_mongo.py.

  python3 -m unittest discover crawler/tests

The Load tests need a MongoDB to write to; they're skipped unless MONGODB_TEST_URI is set
(`npm run db:local` starts a throwaway one on mongodb://127.0.0.1:27018).
"""
import os, sys, unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import events as E  # noqa: E402
import load_to_mongo as L  # noqa: E402

NOW = datetime(2026, 11, 23, 9, 0, tzinfo=E.LOCAL_TZ)


def raw(title, start, end="", **kw):
    e = {"title": title, "start": start, "end": end, "venue": "Venue", "address": "1 Main St", "price": "",
         "url": f"https://example.com/{title.replace(' ', '-')}", "source": "Test", "description": "", "image": ""}
    e.update(kw)
    return e


def select(*events):
    a = E.build_parser().parse_args([])
    return E.select_events([dict(e) for e in events], a, NOW, NOW + timedelta(days=30))


class ToDoc(unittest.TestCase):
    def test_timed_event_keeps_wall_clock_time(self):
        (e,) = select(raw("Boy Golden", "2026-11-25T20:00:00-05:00", price="54.58"))
        d = L.to_doc(e)
        self.assertEqual(d["startLocal"], "2026-11-25T20:00")
        self.assertEqual(d["times"], ["20:00"])
        self.assertFalse(d["allDay"])
        self.assertEqual(d["cost"], "Paid")
        self.assertEqual(d["visibleUntil"] - d["start"], timedelta(hours=6))
        self.assertEqual(d["start"].tzinfo, timezone.utc)

    def test_date_only_event_lasts_all_day(self):
        (e,) = select(raw("Christkindlmarkt", "2026-11-27"))
        d = L.to_doc(e)
        self.assertTrue(d["allDay"])
        self.assertEqual(d["startLocal"], "2026-11-27")
        self.assertEqual(d["times"], [])
        self.assertEqual(d["visibleUntil"] - d["start"], timedelta(days=1, hours=6))

    def test_showings_on_one_day_merge_into_times(self):
        (e,) = select(raw("Otium", "2026-11-23T19:00:00-05:00"), raw("Otium", "2026-11-23T15:00:00-05:00"),
                      raw("Otium", "2026-11-23"))
        d = L.to_doc(e)
        self.assertEqual(d["times"], ["15:00", "19:00"])
        self.assertEqual(d["startLocal"], "2026-11-23T15:00")

    def test_ongoing_exhibition_has_an_end(self):
        (e,) = select(raw("Omalluq: Stories from my Life", "2026-11-25", "2026-12-20"))
        d = L.to_doc(e)
        self.assertIn("ongoing", d["tags"])
        self.assertEqual(d["endLocal"], "2026-12-20")
        self.assertEqual(d["expireAt"] - d["end"], timedelta(days=2))

    def test_film_keeps_structured_showtimes(self):
        shows = [{"cinema": "Scotiabank Theatre Winnipeg", "address": "815 St. James St.", "date": "2026-11-23",
                  "times": ["12:10", "15:20"]}]
        (e,) = select(raw("The Cat in the Hat", "2026-11-23", "2026-11-26", source="CinemaClock (cinema showtimes)",
                          url="https://www.cinemaclock.com/movies/the-cat-in-the-hat-2026",
                          category_hint="Movies & Film", _showtimes=shows))
        d = L.to_doc(e)
        self.assertEqual(d["category"], "Movies & Film")
        self.assertEqual(d["showtimes"], shows)

    def test_stable_id_survives_a_different_source_or_time(self):
        (a,) = select(raw("Jets vs. Hawks", "2026-11-30T19:00:00-05:00", source="AllEvents"))
        (b,) = select(raw("Jets vs. Hawks", "2026-11-30", source="Eventbrite", url="https://other.example/x"))
        (c,) = select(raw("Jets vs. Hawks", "2026-12-02T19:00:00-05:00"))
        self.assertEqual(E.stable_id(a), E.stable_id(b))
        self.assertNotEqual(E.stable_id(a), E.stable_id(c))
        self.assertRegex(E.stable_id(a), r"^evt_[0-9a-f]{16}$")

    def test_each_city_has_its_own_ids_and_the_first_keeps_its_old_ones(self):
        (film,) = select(raw("Wicked", "2026-11-23", source="CinemaClock (cinema showtimes)",
                             url="https://www.cinemaclock.com/movies/wicked"))
        import hashlib
        old = "evt_" + hashlib.sha1(film["url"].encode()).hexdigest()[:16]  # the ID from before cities
        self.assertEqual(E.stable_id(film), old)
        E.use_city("calgary")
        try:
            self.assertNotEqual(E.stable_id(film), old)
            self.assertEqual(L.to_doc(film)["city"], "calgary")
        finally:
            E.use_city(E.DEFAULT_CITY)


class Sources(unittest.TestCase):
    def tearDown(self):
        os.environ.pop("CRAWL_EVENTBRITE", None)
        E.use_city(E.DEFAULT_CITY)

    def test_eventbrite_only_when_asked_for(self):
        E.use_city("calgary")
        self.assertFalse(any(s.startswith("Eventbrite") for s in E.JSONLD_SOURCES))
        os.environ["CRAWL_EVENTBRITE"] = "1"
        E.use_city("calgary")
        self.assertIn("https://www.eventbrite.ca/d/canada--calgary/all-events/?page={page}", E.JSONLD_SOURCES["Eventbrite"])

    def test_every_city_is_complete(self):
        for slug, c in E.CITIES.items():
            E.use_city(slug)  # checks its venue rules' categories
            self.assertTrue(c["crawl"]["allevents"] and c["currency"] and c["timezone"], slug)
            self.assertRegex(slug, r"^[a-z][a-z-]*$")
            self.assertTrue(any(s.startswith("AllEvents") for s in E.JSONLD_SOURCES), slug)

    def test_a_city_can_have_its_own_pages_and_no_ticketmaster_or_cinemas(self):
        E.use_city("lagos")
        self.assertEqual(E.JSONLD_SOURCES, {"AllEvents (incl. Facebook events)": ["https://allevents.in/lagos?page={page}"]})
        self.assertEqual((E.TICKETMASTER_PLACE, E.CINEMACLOCK_THEATRES), ({}, []))
        self.assertEqual(str(E.LOCAL_TZ), "Africa/Lagos")
        os.environ["CRAWL_EVENTBRITE"] = "1"
        E.use_city("lagos")  # Eventbrite's .com site outside Canada
        self.assertEqual(E.JSONLD_SOURCES["Eventbrite"], ["https://www.eventbrite.com/d/nigeria--lagos/all-events/?page={page}"])

    def test_prices_keep_their_currency(self):
        ev = {"@type": "Event", "name": "Afrobeats Night", "startDate": "2026-12-20",
              "offers": {"@type": "AggregateOffer", "lowPrice": "25", "priceCurrency": "USD"}}
        e = E.norm_ld(ev, "AllEvents")
        self.assertEqual((e["price"], e["currency"]), ("25", "USD"))
        (sel,) = select(dict(raw("Afrobeats Night", "2026-12-20"), price="25", currency="USD"))
        self.assertEqual(L.to_doc(sel)["price"], {"text": "25", "free": False, "currency": "USD"})
        self.assertEqual(E.norm_ld(dict(ev, offers={"price": "5000", "priceCurrency": "naira"}), "x")["currency"], "")


class Synopses(unittest.TestCase):
    def setUp(self):
        self.real, self.fetched = E.page_synopsis, []
        E.page_synopsis = lambda url: self.fetched.append(url) or f"About {url}"
        E.SYNOPSES.clear()

    def tearDown(self):
        E.page_synopsis = self.real
        E.SYNOPSES.clear()

    def test_known_ones_are_reused_and_new_ones_remembered(self):
        wicked, new = "https://www.cinemaclock.com/movies/wicked", "https://silverbirdcinemas.com/movie/new-film/"
        week_old = datetime(2026, 11, 20, tzinfo=timezone.utc)
        E.SYNOPSES[wicked] = ("Two witches.", week_old)
        self.assertEqual(E.film_synopsis(wicked, 0), ("Two witches.", week_old))
        text, when = E.film_synopsis(new, 0)
        self.assertEqual((text, self.fetched), (f"About {new}", [new]))
        self.assertEqual(E.film_synopsis(new, 0), (text, when))  # not fetched again
        self.assertEqual(self.fetched, [new])

    def test_a_failed_page_is_not_remembered(self):
        E.page_synopsis = lambda url: None
        self.assertEqual(E.film_synopsis("https://www.cinemaclock.com/movies/x", 0), ("", None))
        self.assertNotIn("https://www.cinemaclock.com/movies/x", E.SYNOPSES)

    def test_stored_with_the_film(self):
        when = datetime(2026, 11, 24, tzinfo=timezone.utc)
        (e,) = select(raw("Wicked", "2026-11-24", source="CinemaClock (cinema showtimes)",
                          url="https://www.cinemaclock.com/movies/wicked", _synopsis="Two witches.", _synopsis_checked=when))
        self.assertEqual((L.to_doc(e)["synopsis"], L.to_doc(e)["synopsisCheckedAt"]), ("Two witches.", when))
        (other,) = select(raw("A talk", "2026-11-24"))
        self.assertNotIn("synopsis", L.to_doc(other))


class Silverbird(unittest.TestCase):
    PAGE = (
        '<article class="entry-item"><div class="entry-thumb"><img width="164" height="220" '
        'src="https://silverbirdcinemas.com/wp-content/uploads/2023/10/hungepost-164x220.jpg" /></div>'
        '<div class="entry-content"><h4 class="entry-title"><a href="https://silverbirdcinemas.com/movie/hunger/">'
        'The Hunger Games</a></h4><div class="entry-date"><i class="fa fa-clock-o"></i>02 hours 38 minutes</div>'
        '<p class="cinema_page_showtime"><b>Showtime:</b> <span><strong>FRI/SAT: </strong></span>'
        '<strong>To be updated 27th November</strong><br><span><strong>WED: </strong></span>'
        '<strong>10:15am(VVIP), 2:00pm</strong><br><span><strong>THUR: </strong></span><strong>'
        '<button><a href= "https://book.example/b1" target="_blank">6:00pm</a></button></strong></p>'
        '<div class="desc-mv"><div><span>Release:</span>Nov 20, 2026</div><div class="note"><span>Genre:</span>'
        '<a href="https://silverbirdcinemas.com/genre/actiion/">Action</a>, '
        '<a href="https://silverbirdcinemas.com/genre/now-showing/">Now Showing</a></div>'
        '<div><span>Language:</span>English </div></div></div></article>'
        '<article class="entry-item"><div class="entry-content"><h4 class="entry-title">'
        '<a href="https://silverbirdcinemas.com/movie/baba-segi/">Baba Segi&#8217;s Wives (Release Dec 4th)</a></h4>'
        '<p class="cinema_page_showtime"><b>Showtime:</b> <span><strong>FRI: </strong></span><strong>'
        '<button><a href= "https://book.example/b2" target="_blank">8:30pm</a></button></strong></p>'
        '<div class="desc-mv"><div><span>Release:</span>Dec 04, 2026</div><div class="note"><span>Genre:</span>'
        '<a href="https://silverbirdcinemas.com/genre/nollywood/">Nollywood</a></div></div></div></article>'
    )

    def setUp(self):
        self.real = E.fetch
        E.fetch = lambda url: self.PAGE

    def tearDown(self):
        E.fetch = self.real

    def test_the_week_s_showings_with_their_booking_links(self):
        tuesday = datetime(2026, 11, 24).date()  # the cinema week is Fri Nov 20 to Thu Nov 26
        hunger, segi = E.sb_cinema("galleria", tuesday)
        self.assertEqual((hunger["title"], hunger["info"]), ("The Hunger Games", "2h 38m · Action · English"))
        self.assertEqual(hunger["shows"], {
            datetime(2026, 11, 25).date(): {(10, 15): "", (14, 0): ""},  # plain times: no booking link
            datetime(2026, 11, 26).date(): {(18, 0): "https://book.example/b1"},
        })
        self.assertEqual(hunger["formats"], {"VVIP"})
        self.assertEqual(hunger["poster"], "https://silverbirdcinemas.com/wp-content/uploads/2023/10/hungepost.jpg")
        # not out yet: its weekdays are those of its opening week
        self.assertEqual((segi["title"], segi["shows"]),
                         ("Baba Segi’s Wives", {datetime(2026, 12, 4).date(): {(20, 30): "https://book.example/b2"}}))

    def test_films_are_keyed_by_their_page(self):
        f = {"title": "Baba Segi’s Wives", "cinemas": {"Silverbird Galleria": ("Victoria Island", {
            datetime(2026, 12, 4).date(): {(20, 30): "https://book.example/b2"}})},
             "info": "", "rating": "", "formats": set(), "cast": "", "poster": "", "family": False}
        row = E.film_row("https://silverbirdcinemas.com/movie/baba-segi/", "Silverbird Cinemas", f, "A comedy.")
        later = dict(row, start="2026-12-05")
        self.assertEqual(E.stable_id(row), E.stable_id(later))
        self.assertEqual(row["_showtimes"][0]["tickets"], ["https://book.example/b2"])


class Tickets(unittest.TestCase):
    def test_cinemaclock_showings_keep_their_ticket_links(self):
        block = ('<div data-earliest-date="20261123" class="x"><p class="times"><u>Today <span class="timesdate">Nov 23'
                 '</span></u><i><span class="tix tod" data-time="1210" id="tix231">12:10 </span> '
                 '<span class="notix" data-time="1520">3:20 </span></i></p>')
        shows, _ = E.cc_showings(block)
        self.assertEqual(shows, {datetime(2026, 11, 23).date(): {
            (12, 10): "https://www.cinemaclock.com/buy-tickets/tix231", (15, 20): ""}})

    def test_allevents_ticket_link_is_the_sellers_own(self):
        page = ("clevertap_obj['external_ticket_url'] = \"https:\\/\\/ticketmaster.evyy.net\\/c\\/1\\/2\\/3?u="
                "https:\\/\\/www.ticketmaster.ca\\/show\\/event\\/10AB\"; ")
        url = E.AE_TICKET_RE.search(page).group(1)
        self.assertEqual(E.unwrap_tracking(url.replace("\\/", "/")), "https://www.ticketmaster.ca/show/event/10AB")
        self.assertEqual(E.unwrap_tracking("https://t.example/c/1?u=https%3A%2F%2Fwww.eventbrite.com%2Fe%2Fx-1%3Faff%3Dae%26lang%3Den"),
                         "https://www.eventbrite.com/e/x-1?lang=en")
        self.assertEqual(E.unwrap_tracking("https://organizer.example/tickets"), "https://organizer.example/tickets")

    def test_ticket_links_are_looked_up_at_most_daily(self):
        events = select(raw("Show A", "2026-11-25T20:00:00-05:00", source="AllEvents"),
                        raw("Show B", "2026-11-26T20:00:00-05:00", source="AllEvents"),
                        raw("Show C", "2026-11-26T20:00:00-05:00", source="Eventbrite"))
        a, b, c = sorted(events, key=lambda e: e["title"])
        now = datetime(2026, 11, 23, 12, tzinfo=timezone.utc)
        known = {E.stable_id(a): {"ticketUrl": "https://www.ticketmaster.ca/a", "ticketCheckedAt": now - timedelta(hours=3)}}
        fetched = []
        real, E.allevents_ticket_url = E.allevents_ticket_url, lambda url: fetched.append(url) or "https://seller.example/b"
        try:
            self.assertEqual(L.add_ticket_links(events, known, now, delay=0), 1)
        finally:
            E.allevents_ticket_url = real
        self.assertEqual(fetched, [b["url"]])
        self.assertEqual(L.to_doc(a)["ticketUrl"], "https://www.ticketmaster.ca/a")
        self.assertEqual(L.to_doc(b)["ticketUrl"], "https://seller.example/b")
        self.assertNotIn("ticketUrl", L.to_doc(c))


@unittest.skipUnless(os.environ.get("MONGODB_TEST_URI"), "set MONGODB_TEST_URI to run against MongoDB")
class Load(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from pymongo import MongoClient
        cls.client = MongoClient(os.environ["MONGODB_TEST_URI"], tz_aware=True)
        cls.db = cls.client[f"loader_test_{os.getpid()}"]

    @classmethod
    def tearDownClass(cls):
        cls.client.drop_database(cls.db.name)
        cls.client.close()

    def run_with(self, *titles, sources=None, at=None, city=E.DEFAULT_CITY, report=()):
        E.use_city(city)
        try:
            docs = L.build_docs(select(*[raw(t, "2026-11-25T20:00:00-05:00") for t in titles]))
        finally:
            E.use_city(E.DEFAULT_CITY)
        counts = sources if sources is not None else {"Test": len(docs)}
        return L.load(self.db, docs, counts, list(report), at, city)

    def test_upserts_removals_and_alerts(self):
        t0 = datetime(2026, 11, 23, 12, tzinfo=timezone.utc)
        run = self.run_with("A", "B", "C", "D", at=t0)
        self.assertEqual((run["upserted"], run["status"]), (4, "ok"))

        run = self.run_with("A", "B", "C", at=t0 + timedelta(hours=6))  # D missing once: still listed
        self.assertEqual((run["upserted"], run["removed"]), (0, 0))
        d = self.db.events.find_one({"title": "D"})
        self.assertEqual((d["status"], d["missedRuns"]), ("active", 1))

        run = self.run_with("A", "B", "C", at=t0 + timedelta(hours=12))  # missing twice: removed
        self.assertEqual(run["removed"], 1)
        self.assertEqual(self.db.events.find_one({"title": "D"})["status"], "removed")

        run = self.run_with("A", at=t0 + timedelta(hours=18))  # 1 event vs 3 last time: partial
        self.assertEqual((run["status"], run["removed"]), ("partial", 0))
        self.assertEqual(self.db.events.find_one({"title": "B"})["status"], "active")

        run = self.run_with("A", "B", "C", sources={"Other": 3}, at=t0 + timedelta(hours=24))
        self.assertEqual((run["status"], run["droppedSources"]), ("alert", ["Test"]))

        run = self.run_with("A", "B", "C", "D", at=t0 + timedelta(hours=30))  # D is back
        self.assertEqual(self.db.events.find_one({"title": "D"})["status"], "active")
        self.assertIsNotNone(self.db.events.find_one({"title": "A"})["firstSeen"])

        # another city's runs don't count against this city's events, or into its "half the usual" check
        for hours in (36, 42):
            run = self.run_with("Calgary 1", at=t0 + timedelta(hours=hours), city="calgary")
            self.assertEqual((run["status"], run["removed"]), ("ok", 0))
        a = self.db.events.find_one({"title": "A"})
        self.assertEqual((a["city"], a["status"], a["missedRuns"]), ("winnipeg", "active", 0))
        self.assertEqual(self.db.events.find_one({"title": "Calgary 1"})["city"], "calgary")

        # a source that errors and finds nothing is an alert, even if it never worked; one bad page isn't
        blocked = ["  ! Blocked: https://blocked.example/?page=1 -> HTTP Error 405: Not Allowed", "  Blocked: 0 found",
                   "  ! Test: https://example.com/?page=2 -> timed out"]
        run = self.run_with("Calgary 1", at=t0 + timedelta(hours=48), city="calgary", report=blocked)
        self.assertEqual((run["status"], run["failedSources"], run["droppedSources"]), ("alert", ["Blocked"], []))


if __name__ == "__main__":
    unittest.main()
