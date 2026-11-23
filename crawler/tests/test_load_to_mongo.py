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

    def run_with(self, *titles, sources=None, at=None):
        docs = L.build_docs(select(*[raw(t, "2026-11-25T20:00:00-05:00") for t in titles]))
        counts = sources if sources is not None else {"Test": len(docs)}
        return L.load(self.db, docs, counts, [], at)

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


if __name__ == "__main__":
    unittest.main()
