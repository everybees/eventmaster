"""Tests for load_to_mongo.py.

  python3 -m unittest discover crawler/tests

The Load tests need a MongoDB to write to; they're skipped unless MONGODB_TEST_URI is set
(`npm run db:local` starts a throwaway one on mongodb://127.0.0.1:27018).
"""
import json, os, sys, unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import events as E  # noqa: E402
import load_to_mongo as L  # noqa: E402
import suggestions as S  # noqa: E402

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
        # kept a month after it ends (the end date lasts all day), for "Did you go?" answers
        self.assertEqual(d["expireAt"] - d["end"], timedelta(days=1) + L.KEEP_AFTER_END)

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


ABEOKUTA = {"_id": "abeokuta-ng", "placeId": 2352947, "name": "Abeokuta", "ascii": "Abeokuta", "region": "Ogun State",
            "country": "NG", "countryName": "Nigeria", "currency": "NGN", "timezone": "Africa/Lagos", "lat": 7.16,
            "lon": 3.35, "population": 735000, "status": "pending", "requests": 3,
            "firstRequestedAt": datetime(2026, 11, 26, tzinfo=timezone.utc)}


class RequestedCities(unittest.TestCase):
    def tearDown(self):
        E.CITIES.pop("abeokuta-ng", None)
        E.use_city(E.DEFAULT_CITY)

    def test_settings_come_from_the_request(self):
        E.CITIES["abeokuta-ng"] = L.requested_city(ABEOKUTA)
        E.use_city("abeokuta-ng")
        self.assertEqual((E.CITY_NAME, str(E.LOCAL_TZ)), ("Abeokuta", "Africa/Lagos"))
        self.assertEqual(E.JSONLD_SOURCES["AllEvents (incl. Facebook events)"],
                         ["https://allevents.in/abeokuta/all?page={page}", "https://allevents.in/abeokuta?page={page}"])
        self.assertEqual(E.TICKETMASTER_PLACE, {"city": "Abeokuta", "countryCode": "NG"})
        self.assertEqual((E.CINEMACLOCK_THEATRES, E.SILVERBIRD_CINEMAS), ([], []))

    def test_names_normalize_as_the_api_does(self):
        # tests/api.test.mts checks netlify/lib/places.mts's normalizeName against the same pairs
        for name, key in [("St. John's", 'st johns'), ('Montréal', 'montreal'), ('Kitchener-Waterloo', 'kitchener waterloo'), ('  Québec   City ', 'quebec city'), ('Ōsaka', 'osaka')]:
            self.assertEqual(E.norm(name), key)

    def test_a_redirect_away_from_the_city_means_no_page(self):
        self.assertFalse(E.same_place("https://allevents.in/abeokuta?page=1", "https://allevents.in/events?page=1"))
        self.assertTrue(E.same_place("https://allevents.in/lagos?page=2", "https://allevents.in/lagos?page=2"))
        self.assertTrue(E.same_place("https://allevents.in/calgary/all?page=1", "https://allevents.in/calgary/all"))

    def test_without_a_database_only_the_configured_cities(self):
        self.assertEqual(L.cities_to_crawl(None), list(E.CITIES))


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


class Filmhouse(unittest.TestCase):
    LLMS = (
        "# Filmhouse\n\n## Locations\n\n- Akure\n- Circle Mall\n- Landmark\n- Surulere\n\n"
        "## Now showing\n\nEach page lists showtimes and links to book tickets.\n\n"
        "- [BABA SEGI'S WIVES](https://www.filmhouseng.com/movies/babasegi-2026): Comedy · 1h 50m\n"
        "- [AGBARA NLA](https://www.filmhouseng.com/movies/agbaranla-2026): Epic · 2h 37m\n"
        "- [DUNE : PART THREE](https://www.filmhouseng.com/movies/dunepartthree-2026): Adventure, Epic · 2h 30m\n\n"
        "## Coming soon\n\n- [JUMANJI: OPEN WORLD](https://www.filmhouseng.com/movies/jumanjiopenworld-2026): Action · 2h 0m\n\n"
        "## Pages\n\n- [Buy Tickets](https://www.filmhouseng.com/buy-tickets)\n"
    )
    DUNE = ('<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Organization"},'
            '{"@type":"Movie","name":"DUNE : PART THREE","description":"Paul&#39;s war.",'
            '"image":["https://filmhouseng.static.cinesync.io/images/movie/2poster.webp",'
            '"https://filmhouseng.static.cinesync.io/images/movie/1banner.webp"],"duration":"PT2H30M",'
            '"genre":["Adventure","Epic"],"contentRating":"12A","datePublished":"2026-12-18",'
            '"actor":[{"@type":"Person","name":"Zendaya"},{"@type":"Person","name":"Timothée Chalamet"}]}]}</script>')

    def setUp(self):
        self.real, self.fetched = E.fetch, []
        def fake(url):
            self.fetched.append(url)
            return self.LLMS if url.endswith("/llms.txt") else self.DUNE if "dune" in url else "<html></html>"
        E.fetch = fake
        E.use_city("lagos")
        E.FILMHOUSE_CINEMAS = ["Circle Mall", "Landmark", "Oniru"]  # Oniru isn't in this llms.txt: left out

    def tearDown(self):
        E.fetch = self.real
        E.use_city(E.DEFAULT_CITY)

    def silverbird_row(self, title, info):
        f = {"title": title, "cinemas": {"Silverbird Galleria": ("Victoria Island", {
            datetime(2026, 11, 25).date(): {(20, 30): "https://book.example/b2"}})},
             "info": info, "rating": "", "formats": set(), "cast": "", "poster": "", "family": False}
        return E.film_row(f"https://silverbirdcinemas.com/movie/{title[:8]}/", "Silverbird Cinemas", f, "")

    def test_reads_the_films_now_showing(self):
        films, cinemas = E.fh_listing(self.LLMS)
        self.assertEqual([f["title"] for f in films], ["BABA SEGI'S WIVES", "AGBARA NLA", "DUNE : PART THREE"])
        self.assertEqual(films[1]["info"], "Epic · 2h 37m")
        self.assertEqual(cinemas, ["Akure", "Circle Mall", "Landmark", "Surulere"])

    def test_titles_out_of_capitals(self):
        for given, want in [("DUNE : PART THREE", "Dune: Part Three"), ("THE CAT IN THE HAT", "The Cat in the Hat"),
                            ("TELE X ZIKORA", "Tele X Zikora"), ("FOCKER IN-LAW", "Focker In-Law"),
                            ("ROCKY II", "Rocky II"), ("ARNIE & BARNEY", "Arnie & Barney"),
                            ("WAR: THE RETURN", "War: The Return"), ("Ramayana", "Ramayana")]:
            self.assertEqual(E.fh_title(given), want)

    def test_matches_silverbird_s_films(self):
        segi = self.silverbird_row("Baba Segi’s Wives", "1h 50m · Comedy")
        agbara = self.silverbird_row("Agbara Nla: The Return", "2h 37m · Drama, Nollywood")
        dune2 = self.silverbird_row("Dune: Part Two", "2h 46m · Sci-Fi")
        rows = [segi, agbara, dune2]
        self.assertIs(E.fh_same_film(rows, "Baba Segi's Wives", "1h 50m"), segi)  # ’ and ' are the same
        self.assertIs(E.fh_same_film(rows, "Agbara Nla", "2h 37m"), agbara)       # one adds a subtitle, same length
        self.assertIsNone(E.fh_same_film(rows, "Agbara Nla", "1h 40m"))           # ... another film's length
        self.assertIsNone(E.fh_same_film(rows, "Dune: Part Three", "2h 30m"))     # two subtitles: other films

    def test_links_shared_films_and_lists_the_rest(self):
        agbara = self.silverbird_row("Agbara Nla: The Return", "2h 37m · Drama, Nollywood")
        rows = [agbara]
        tuesday = datetime(2026, 11, 24).date()
        own = E.filmhouse(0, rows, today=tuesday)
        # Agbara Nla: a link in Silverbird's row, no page fetched for it
        self.assertEqual(agbara["_showtimes"][-1], {
            "cinema": "Filmhouse", "address": "Circle Mall, Landmark", "date": "2026-11-25", "times": [], "tickets": [],
            "url": "https://www.filmhouseng.com/movies/agbaranla-2026"})
        self.assertEqual((agbara["venue"], agbara["address"]), ("2 cinemas", "Silverbird Galleria, Filmhouse"))
        self.assertNotIn("https://www.filmhouseng.com/movies/agbaranla-2026", self.fetched)
        E.filmhouse(0, rows, today=tuesday)  # a second pass doesn't link it twice
        self.assertEqual(sum(s["cinema"] == "Filmhouse" for s in agbara["_showtimes"]), 1)
        # the others: rows of their own, and nothing from Coming soon
        self.assertEqual([r["title"] for r in own], ["Baba Segi's Wives", "Dune: Part Three"])
        segi, dune = own
        self.assertEqual((segi["title"], segi["start"], segi["end"]), ("Baba Segi's Wives", "2026-11-24", "2026-11-26"))
        self.assertEqual(segi["description"], "1h 50m · Comedy")  # its page had no Movie: llms.txt's details
        self.assertEqual((dune["title"], dune["start"], dune["end"]), ("Dune: Part Three", "2026-12-18", "2026-12-24"))
        self.assertEqual(dune["description"],
                         "2h 30m · Adventure, Epic · Rated 12A · With Zendaya, Timothée Chalamet. Paul's war.")
        self.assertEqual(dune["image"], "https://filmhouseng.static.cinesync.io/images/movie/2poster.webp")
        self.assertEqual((dune["venue"], dune["address"]), ("Filmhouse", "2 cinemas in Lagos"))
        self.assertEqual(dune["_showtimes"][0]["date"], "2026-12-18")
        # keyed by its Filmhouse page, as Silverbird's films are by theirs
        self.assertEqual(E.stable_id(dune), E.stable_id(dict(dune, start="2026-12-25")))

    def test_stored_with_its_link(self):
        own = E.filmhouse(0, [], today=datetime(2026, 11, 24).date())
        (e,) = [x for x in select(*own) if x["title"] == "Baba Segi's Wives"]
        d = L.to_doc(e)
        self.assertEqual((d["source"], d["startLocal"], d["endLocal"], d["tags"]),
                         ("Filmhouse", "2026-11-24", "2026-11-26", ["ongoing"]))
        self.assertEqual(d["showtimes"][0]["url"], "https://www.filmhouseng.com/movies/babasegi-2026")

    def test_an_empty_listing_fails(self):
        self.LLMS = "# Filmhouse\n\n## Now showing\n\n"
        with self.assertRaises(ValueError):
            E.filmhouse(0, [])


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


class Suggestions(unittest.TestCase):
    NOW = datetime(2026, 11, 27, 12, tzinfo=timezone.utc)
    PAGE = ('<script type="application/ld+json">{"@context":"https://schema.org","@type":"MusicEvent",'
            '"name":"Burna Boy: Love, Damini Live","startDate":"2026-12-06T19:00:00+01:00",'
            '"location":{"@type":"Place","name":"Eko Convention Centre","address":{"streetAddress":"Plot 1415 Adetokunbo Ademola St",'
            '"addressLocality":"Victoria Island"}},"offers":{"@type":"Offer","lowPrice":"25000","highPrice":"150000",'
            '"priceCurrency":"NGN"},"image":"https://cdn.tix.africa/e/burna.jpg","description":"One night only."}</script>')

    def setUp(self):
        self.real, self.fetched = E.fetch_final, []
        def fake(url, timeout=25):
            self.fetched.append(url)
            return self.PAGE, url
        E.fetch_final = fake
        E.use_city("lagos")

    def tearDown(self):
        E.fetch_final = self.real
        E.use_city(E.DEFAULT_CITY)

    @staticmethod
    def draft(**kw):
        d = {"suggestion": "3f9a0c12", "city": "lagos", "title": "Detty December Rooftop Party", "start": "2026-12-20T18:00",
             "end": "", "venue": "Muri Okunola Park", "address": "Victoria Island", "price": "Free", "currency": "",
             "category": "", "image": "", "description": "Sundown to late.", "url": "https://www.instagram.com/p/DdTtY"}
        d.update(kw)
        return d

    def test_names_the_link_s_site(self):
        self.assertEqual([S.site_name(u) for u in ("https://www.instagram.com/p/x", "https://m.facebook.com/events/1",
                                                    "https://tix.africa/discover/x", "https://www.eventbrite.co.uk/e/1",
                                                    "https://shop.example.ng/e")],
                         ["Instagram", "Facebook", "Tix Africa", "Eventbrite", "shop.example.ng"])

    def test_a_draft_from_the_page_in_the_city_s_time(self):
        e, how = S.page_event("https://tix.africa/discover/burna")
        self.assertTrue(how.startswith("Filled in from the page"))
        self.assertEqual((e["title"], e["start"], e["end"]), ("Burna Boy: Love, Damini Live", "2026-12-06T19:00", ""))
        self.assertEqual((e["venue"], e["address"]), ("Eko Convention Centre", "Plot 1415 Adetokunbo Ademola St, Victoria Island"))
        self.assertEqual((e["price"], e["currency"], e["image"]), ("25000–150000", "NGN", "https://cdn.tix.africa/e/burna.jpg"))

    def test_never_fetches_instagram_or_facebook(self):
        for url in ("https://www.instagram.com/p/DdTtY", "https://web.facebook.com/events/123", "https://fb.me/e/abc"):
            e, how = S.page_event(url)
            self.assertIsNone(e)
            self.assertIn("aren't fetched", how)
        self.assertEqual(self.fetched, [])

    def test_says_what_s_wrong_with_a_draft(self):
        self.assertEqual(S.problems(self.draft()), [])
        self.assertEqual(S.problems(self.draft(title=" ", start="6 Dec 7pm")),
                         ["title is empty", "start must look like 2026-12-06T19:00, or 2026-12-06"])
        self.assertEqual(S.problems(self.draft(end="2026-12-19")), ["end is before start"])
        self.assertIn("category must be empty or one of", S.problems(self.draft(category="Parties"))[0])
        self.assertIn("stop working", S.problems(self.draft(image="https://scontent.cdninstagram.com/v/t51/x.jpg?oe=1"))[0])

    def test_builds_the_event_as_the_crawl_would(self):
        d = S.event_doc(self.draft(), self.NOW.astimezone(E.LOCAL_TZ))
        self.assertEqual(d["_id"], E.stable_id({"title": "Detty December Rooftop Party", "tags": [],
                                                "_dt": datetime(2026, 12, 20, 18, tzinfo=E.LOCAL_TZ)}))
        self.assertEqual((d["city"], d["startLocal"], d["start"]), ("lagos", "2026-12-20T18:00",
                                                                     datetime(2026, 12, 20, 17, tzinfo=timezone.utc)))
        self.assertEqual((d["category"], d["cost"], d["source"]), ("Nightlife & Parties", "Free", "Instagram"))
        d = S.event_doc(self.draft(category="Family & Kids"), self.NOW)  # a category given wins
        self.assertEqual((d["category"], d["tags"]), ("Family & Kids", ["family"]))

    def test_an_ended_event_isn_t_added(self):
        with self.assertRaises(SystemExit):
            S.event_doc(self.draft(start="2026-11-20T18:00"), self.NOW.astimezone(E.LOCAL_TZ))

    def test_warns_about_pictures_the_image_cdn_won_t_fetch(self):
        self.assertEqual(S.image_note("https://silverbirdcinemas.com/wp-content/x.jpg"), "")
        self.assertIn("isn't in netlify.toml", S.image_note("https://cdn.tix.africa/e/burna.jpg"))


class Beyond30(unittest.TestCase):
    @staticmethod
    def event(town, country, start, name=None, **kw):
        e = {"@context": "http://www.schema.org", "@type": "Event",
             "name": name or f"80s &#038; 90s Over 30s Daytime Clubbing &#8211; {town.upper()}🕺🏽",
             "url": f"https://www.beyond30events.com/event/{town.lower()}/", "image": "https://cdn2.fatsoma.com/media/x1",
             "startDate": start, "endDate": start, "description": "Party!\n🕒 Time: 4PM – 9PM\nCONTACT US: 📧 bookings@x",
             "location": {"@type": "Place", "name": f"{town} Club", "address": {
                 "@type": "PostalAddress", "streetAddress": f"1 Main St, {town}, {country}", "addressLocality": town,
                 "addressCountry": country}},
             "offers": [{"@type": "Offer", "price": "30.00", "priceCurrency": "CAD", "availability": "InStock"},
                        {"@type": "Offer", "price": "25.00", "priceCurrency": "CAD", "availability": "InStock"}]}
        e.update(kw)
        return e

    def page(self, *events):
        return "".join(f'<script type="application/ld+json">{json.dumps(e)}</script>' for e in events)

    def setUp(self):
        self.real, self.asked = E.fetch_final, []
        self.listed = []
        def fake(url, timeout=25, compressed=False):
            self.asked.append((url, compressed))
            return self.page(*self.listed), url
        E.fetch_final = fake

    def tearDown(self):
        E.fetch_final = self.real
        E.use_city(E.DEFAULT_CITY)

    def test_each_city_gets_its_own_events_in_its_own_time(self):
        self.listed = [
            # Winnipeg: their UTC is from Winnipeg's old offset (3 pm at -06:00); the stated time wins
            self.event("Winnipeg", "Canada", "2026-12-12T21:00", description="Time: 3:00 – 8:00pm"),
            self.event("London", "Canada", "2026-12-05T21:00"),           # 4 pm in London, Ontario
            self.event("London", "United Kingdom", "2026-12-05T16:00"),   # not that London
            self.event("Vancouver", "Canada", "2026-12-06T01:00", description="no time given"),
            self.event("Cambridge", "Canada", "2026-12-12T21:00"),        # Kitchener-Waterloo's (towns)
        ]
        # with no stated time, UTC by the city's rules (British Columbia's changed in 2026 too)
        vancouver = datetime(2026, 12, 6, 1, tzinfo=timezone.utc).astimezone(ZoneInfo("America/Vancouver"))
        for city, want in (("winnipeg", ["2026-12-12T15:00"]), ("london", ["2026-12-05T16:00"]),
                           ("vancouver", [vancouver.strftime("%Y-%m-%dT%H:%M")]), ("kitchener-waterloo", ["2026-12-12T16:00"]),
                           ("lagos", [])):
            E.use_city(city)
            self.assertEqual([e["start"] for e in E.beyond30()], want, city)
        self.assertTrue(all(compressed for _, compressed in self.asked))

    def test_a_row_like_any_other_source_s(self):
        self.listed = [self.event("Winnipeg", "Canada", "2026-12-12T21:00")]
        E.use_city("winnipeg")
        (e,) = E.beyond30()
        self.assertEqual((e["title"], e["venue"], e["address"]), ("80s & 90s Over 30s Daytime Clubbing", "Winnipeg Club", "1 Main St, Winnipeg"))
        self.assertEqual((e["price"], e["currency"], e["source"], e["description"]), ("25–30", "CAD", "Beyond 30", "Party! 🕒 Time: 4PM – 9PM"))
        (sel,) = E.select_events([e], E.build_parser().parse_args([]), NOW, NOW + timedelta(days=30))
        self.assertEqual((sel["category"], L.to_doc(sel)["startLocal"]), ("Nightlife & Parties", "2026-12-12T16:00"))

    def test_cancelled_left_out_and_sold_out_said(self):
        self.listed = [self.event("Winnipeg", "Canada", "2026-12-12T21:00", name="Over 30s &#8211; WINNIPEG🕺 CANCELLED"),
                       self.event("Winnipeg", "Canada", "2026-12-19T21:00", eventStatus="https://schema.org/EventCancelled"),
                       self.event("Winnipeg", "Canada", "2026-12-26T21:00", name="Over 30s &#8211; WINNIPEG (SOLD OUT)")]
        E.use_city("winnipeg")
        self.assertEqual([(e["title"], e["price"]) for e in E.beyond30()], [("Over 30s", "Sold out")])

    def test_an_empty_page_fails(self):
        E.use_city("winnipeg")
        with self.assertRaises(ValueError):
            E.beyond30()


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

    def test_a_sparse_source_finding_none_is_no_alert(self):
        t0 = datetime(2026, 12, 1, 12, tzinfo=timezone.utc)
        run = self.run_with("P", "Q", sources={"Test": 1, "Beyond 30": 1}, at=t0, city="halifax")
        self.assertEqual(run["status"], "ok")
        run = self.run_with("P", "Q", sources={"Test": 2}, at=t0 + timedelta(hours=6), city="halifax")
        self.assertEqual((run["status"], run["droppedSources"]), ("ok", []))
        failed = ["  ! Beyond 30 -> HTTP Error 500: Internal Server Error"]
        run = self.run_with("P", "Q", sources={"Test": 2}, at=t0 + timedelta(hours=12), city="halifax", report=failed)
        self.assertEqual((run["status"], run["failedSources"]), ("alert", ["Beyond 30"]))

    def test_requested_cities_to_crawl_and_going_live(self):
        reqs = self.db.cityRequests
        reqs.insert_many([dict(ABEOKUTA), dict(ABEOKUTA, _id="ibadan-ng", placeId=2, requests=9),
                          dict(ABEOKUTA, _id="ilorin-ng", placeId=3, status="unavailable", requests=20),
                          dict(ABEOKUTA, _id="jos-ng", placeId=4, status="waitlisted", requests=30),
                          dict(ABEOKUTA, _id="kano-ng", placeId=5, status="active", requests=1)])
        # configured cities, then pending and live requested ones, most requested first
        self.assertEqual(L.cities_to_crawl(self.db), list(E.CITIES) + ["ibadan-ng", "abeokuta-ng", "kano-ng"])
        done = datetime(2026, 11, 26, 18, tzinfo=timezone.utc)
        self.assertEqual(L.mark_requested_city(self.db, "abeokuta-ng", {"total": 12, "finishedAt": done}), "active")
        self.assertEqual(L.mark_requested_city(self.db, "ibadan-ng", {"total": 2, "finishedAt": done}), "unavailable")
        self.assertEqual(reqs.find_one({"_id": "abeokuta-ng"})["eventCount"], 12)
        self.assertEqual(L.cities_to_crawl(self.db), list(E.CITIES) + ["abeokuta-ng", "kano-ng"])


@unittest.skipUnless(os.environ.get("MONGODB_TEST_URI"), "set MONGODB_TEST_URI to run against MongoDB")
class SuggestionsInMongo(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from pymongo import MongoClient
        cls.client = MongoClient(os.environ["MONGODB_TEST_URI"], tz_aware=True)
        cls.db = cls.client[f"suggestions_test_{os.getpid()}"]

    @classmethod
    def tearDownClass(cls):
        cls.client.drop_database(cls.db.name)
        cls.client.close()

    def tearDown(self):
        E.use_city(E.DEFAULT_CITY)

    def test_added_events_are_listed_and_crawls_leave_them(self):
        t0 = datetime(2026, 11, 27, 12, tzinfo=timezone.utc)
        url = "https://www.instagram.com/p/DdTtY"
        self.db.suggestions.insert_many([
            {"deviceId": d, "city": "lagos", "url": url, "key": "3f9a0c12", "note": n, "at": t0, "updatedAt": t0, "status": "new"}
            for d, n in (("a", "Sat 20 Dec, 6 pm"), ("b", ""))])
        draft = Suggestions.draft()
        doc, new = S.add(self.db, draft, t0)
        self.assertTrue(new)
        stored = self.db.events.find_one({"_id": doc["_id"]})
        self.assertEqual((stored["status"], stored["manual"], stored["missedRuns"], stored["city"]), ("active", True, 0, "lagos"))
        self.assertEqual({(x["status"], x["eventId"]) for x in self.db.suggestions.find()}, {("added", doc["_id"])})
        self.assertEqual(S.add(self.db, draft, t0)[1], False)  # the same again: updated in place

        # two of Lagos's crawls without it: crawled events go, it stays
        E.use_city("lagos")
        crawled = L.build_docs(select(raw("Lagos Jazz Night", "2026-12-05T20:00:00+01:00"),
                                      raw("Art Market", "2026-12-06T10:00:00+01:00")))
        for hours in (6, 12):
            L.load(self.db, crawled, {"Test": 2}, [], t0 + timedelta(hours=hours), "lagos")
        L.load(self.db, crawled[:1], {"Test": 1}, [], t0 + timedelta(hours=18), "lagos")
        L.load(self.db, crawled[:1], {"Test": 1}, [], t0 + timedelta(hours=24), "lagos")
        self.assertEqual(self.db.events.find_one({"title": "Art Market"})["status"], "removed")
        stored = self.db.events.find_one({"_id": doc["_id"]})
        self.assertEqual((stored["status"], stored["missedRuns"]), ("active", 0))

        # taken down when it's cancelled; crawled events can't be
        S.cmd_remove(self.db, SimpleNamespace(event_id=doc["_id"]))
        self.assertEqual(self.db.events.find_one({"_id": doc["_id"]})["status"], "removed")
        with self.assertRaises(SystemExit):
            S.cmd_remove(self.db, SimpleNamespace(event_id=crawled[0]["_id"]))

    def test_rejecting_and_finding_by_key(self):
        t0 = datetime(2026, 11, 27, 12, tzinfo=timezone.utc)
        self.db.suggestions.insert_many([
            {"deviceId": "c", "city": "abuja", "url": f"https://shop.example.ng/{k}", "key": k, "note": "", "at": t0,
             "updatedAt": t0, "status": "new"} for k in ("ab12cd34", "ab99ef00")])
        with self.assertRaises(SystemExit):
            S.by_link(self.db, "ab")  # two links start so
        S.cmd_reject(self.db, SimpleNamespace(key="ab12"))
        self.assertEqual(self.db.suggestions.find_one({"key": "ab12cd34"})["status"], "rejected")
        self.assertEqual(self.db.suggestions.find_one({"key": "ab99ef00"})["status"], "new")


if __name__ == "__main__":
    unittest.main()
