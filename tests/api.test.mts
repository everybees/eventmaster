// API tests against a throwaway MongoDB:  npm test
// Each function is called the way Netlify calls it: (Request, Context) -> Response.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { after, before, describe, test } from "node:test";
import type { Context } from "@netlify/functions";
import Ajv2020 from "ajv/dist/2020.js";
import { MongoMemoryServer } from "mongodb-memory-server";
import type { Db } from "mongodb";
import type {
  ApiEvent, CitiesResponse, CityRequestResponse, EventsResponse, NearestResponse, PlacesResponse, StateResponse,
  SuggestionResponse,
} from "../shared/types.ts";
import { forgetLiveCities } from "../netlify/lib/cities.mts";
import { normalizeName, type PlaceDoc } from "../netlify/lib/places.mts";
import { closeDb, getDb } from "../netlify/lib/db.mts";
import { setupIndexes } from "../netlify/lib/indexes.mts";
import { soonestShowtimes, toApiEvent, todayIn, withoutReplacedFilms, type EventDoc } from "../netlify/lib/models.mts";
import { ticketsFor } from "../netlify/lib/tickets.mts";
import eventsFn from "../netlify/functions/events.mts";
import eventFn from "../netlify/functions/event.mts";
import citiesFn from "../netlify/functions/cities.mts";
import interactionsFn from "../netlify/functions/interactions.mts";
import meFn from "../netlify/functions/me.mts";
import placesFn from "../netlify/functions/places.mts";
import cityRequestsFn from "../netlify/functions/city-requests.mts";
import remindersFn from "../netlify/functions/reminders.mts";
import tallyFn from "../netlify/functions/tally.mts";
import suggestionsFn from "../netlify/functions/suggestions.mts";
import { cleanLink, linkKey, type SuggestionDoc } from "../netlify/lib/suggestions.mts";
import { computeStats, MIN_PEOPLE } from "../netlify/lib/stats.mts";
import { remindersFor, sendReminders, zonedTime, type ReminderDoc, type Sender } from "../netlify/lib/reminders.mts";
import * as webpush from "web-push";

const BASE = "http://localhost:8888";
const HOUR = 3600_000;
const ctx = (params: Record<string, string> = {}) => ({ params }) as unknown as Context;
const schema = JSON.parse(readFileSync(new URL("../shared/event.schema.json", import.meta.url), "utf8"));
const validateEvent = new Ajv2020({ allErrors: true }).compile(schema);

let mongod: MongoMemoryServer;
let db: Db;

function eventDoc(id: string, overrides: Partial<EventDoc> = {}): EventDoc {
  const start = new Date(Date.now() + 24 * HOUR);
  return {
    _id: id, title: `Event ${id}`, category: "Music & Concerts", tags: [],
    start, end: null, startLocal: "2026-11-24T19:00", endLocal: null, allDay: false, times: ["19:00"],
    venue: { name: "Park Theatre", address: "698 Osborne St" }, price: { text: "25", free: false }, cost: "Paid",
    image: "https://img.example/x.jpg", description: "A show.", url: "https://example.com/x", source: "Eventbrite",
    showtimes: [], status: "active", visibleUntil: new Date(start.getTime() + 6 * HOUR),
    expireAt: new Date(start.getTime() + 48 * HOUR),
    ...overrides,
  };
}

const ID = { music: "evt_000000000000000a", film: "evt_000000000000000b", past: "evt_000000000000000c",
  removed: "evt_000000000000000d", later: "evt_000000000000000e", calgary: "evt_000000000000000f" };

before(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB = "api_test";
  db = await getDb();
  await setupIndexes(db);
  await db.collection<EventDoc>("events").insertMany([
    eventDoc(ID.music, { city: "winnipeg", url: "https://www.ticketmaster.ca/holiday-jazz-night/event/0B00613E", source: "Ticketmaster" }),
    eventDoc(ID.film, {
      category: "Movies & Film", tags: ["family", "ongoing"], start: new Date(Date.now() - 2 * HOUR),
      end: new Date(Date.now() + 72 * HOUR), startLocal: "2026-11-23", endLocal: "2026-11-26", allDay: true, times: [],
      visibleUntil: new Date(Date.now() + 80 * HOUR), source: "CinemaClock (cinema showtimes)",
      showtimes: [{ cinema: "Scotiabank Theatre Winnipeg", address: "815 St. James St.", date: "2026-11-23", times: ["12:10", "15:20"] }],
    }),
    eventDoc(ID.past, { start: new Date(Date.now() - 30 * HOUR), visibleUntil: new Date(Date.now() - 20 * HOUR) }),
    eventDoc(ID.removed, { status: "removed" }),
    eventDoc(ID.later, { start: new Date(Date.now() + 10 * 24 * HOUR), visibleUntil: new Date(Date.now() + 11 * 24 * HOUR) }),
    // the other fixtures have no `city`, like the first city's events from before cities
    eventDoc(ID.calgary, { city: "calgary", source: "AllEvents (incl. Facebook events)", url: "https://allevents.in/calgary/x/1",
      ticketUrl: "https://www.winterfest.example/tickets" }),
  ]);
});

after(async () => {
  await closeDb();
  await mongod.stop();
});

const get = (path: string, headers: HeadersInit = {}) => new Request(BASE + path, { headers });
const post = (path: string, body: unknown) =>
  new Request(BASE + path, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: { "content-type": "application/json" } });

describe("GET /api/events", () => {
  test("lists active, still-running events soonest first, in the shared schema, cacheable", async () => {
    const res = await eventsFn(get("/api/events"), ctx());
    assert.equal(res.status, 200);
    assert.match(res.headers.get("netlify-cdn-cache-control") ?? "", /s-maxage=/);
    const body = (await res.json()) as EventsResponse;
    assert.deepEqual(body.events.map((e) => e.id), [ID.film, ID.music, ID.later]);
    for (const e of body.events) assert.ok(validateEvent(e), JSON.stringify(validateEvent.errors));
  });

  test("filters by category, tag and date range", async () => {
    const ids = async (qs: string) =>
      ((await (await eventsFn(get(`/api/events?${qs}`), ctx())).json()) as EventsResponse).events.map((e) => e.id);
    assert.deepEqual(await ids("category=Movies%20%26%20Film"), [ID.film]);
    assert.deepEqual(await ids("tag=family"), [ID.film]);
    const inThreeDays = new Date(Date.now() + 3 * 24 * HOUR).toISOString();
    assert.deepEqual(await ids(`to=${inThreeDays}`), [ID.film, ID.music]);
    assert.deepEqual(await ids("limit=1"), [ID.film]);
  });

  test("is one city's feed: the default city's, or ?city=, and 400 for a city we don't cover", async () => {
    const feed = async (qs: string) => (await (await eventsFn(get(`/api/events${qs}`), ctx())).json()) as EventsResponse;
    assert.deepEqual((await feed("?city=calgary")).events.map((e) => [e.id, e.city]), [[ID.calgary, "calgary"]]);
    const winnipeg = await feed("?city=winnipeg");
    assert.equal(winnipeg.city, "winnipeg");
    assert.deepEqual(winnipeg.events.map((e) => e.id), [ID.film, ID.music, ID.later]);
    assert.ok(winnipeg.events.every((e) => e.city === "winnipeg"));
    assert.equal((await eventsFn(get("/api/events?city=atlantis"), ctx())).status, 400);
  });

  test("rejects a bad date", async () => {
    assert.equal((await eventsFn(get("/api/events?from=soon"), ctx())).status, 400);
  });
});

describe("GET /api/events/:id", () => {
  test("returns one event, 404 when unknown, 400 when malformed", async () => {
    const ok = await eventFn(get(`/api/events/${ID.film}`), ctx({ id: ID.film }));
    assert.equal(ok.status, 200);
    assert.equal(((await ok.json()) as { title: string }).title, `Event ${ID.film}`);
    assert.equal((await eventFn(get("/api/events/evt_ffffffffffffffff"), ctx({ id: "evt_ffffffffffffffff" }))).status, 404);
    assert.equal((await eventFn(get("/api/events/nope"), ctx({ id: "nope" }))).status, 400);
  });
});

describe("showtimes in the feed", () => {
  test("are each cinema's next two days, from today in the city's time zone", () => {
    const day = (n: number) => new Date(Date.UTC(2026, 10, 24 + n)).toISOString().slice(0, 10);
    const show = (cinema: string, n: number) => ({ cinema, address: "", date: day(n), times: ["19:00"], tickets: [""] });
    const all = [show("A", -1), show("A", 0), show("A", 1), show("A", 2), show("B", 3), show("B", 5), show("B", 4)];
    assert.deepEqual(soonestShowtimes(all, day(0)).map((s) => `${s.cinema} ${s.date}`),
      [`A ${day(0)}`, `A ${day(1)}`, `B ${day(3)}`, `B ${day(4)}`]);
    // a cinema whose times are on its own site (Filmhouse) stays, though its entry is dated the day it was crawled
    const elsewhere = { cinema: "Filmhouse", address: "Ikota, Landmark", date: day(-1), times: [], tickets: [],
      url: "https://www.filmhouseng.com/movies/x-2026" };
    assert.deepEqual(soonestShowtimes([show("A", 0), elsewhere], day(0)).map((s) => s.cinema).sort(), ["A", "Filmhouse"]);
    assert.ok(validateEvent(toApiEvent(eventDoc(ID.film, { showtimes: [elsewhere] }))), JSON.stringify(validateEvent.errors));
    // 03:45 UTC on Nov 24 is still Nov 23 in Winnipeg and Vancouver, but 00:15 on Nov 24 in St. John's (UTC-3:30)
    const at = new Date("2026-11-24T03:45:00Z");
    assert.deepEqual([todayIn("America/Winnipeg", at), todayIn("America/Vancouver", at), todayIn("America/St_Johns", at)],
      ["2026-11-23", "2026-11-23", "2026-11-24"]);
  });
});

describe("films that moved to another row", () => {
  test("the row the last crawl didn't see is left out while another has the film", () => {
    const times = [{ cinema: "Silverbird Galleria", address: "", date: "2026-11-26", times: ["18:00"], tickets: [""] }];
    const link = [{ cinema: "Filmhouse", address: "", date: "2026-11-26", times: [], tickets: [], url: "https://www.filmhouseng.com/movies/x" }];
    const row = (title: string, missedRuns: number, showtimes: EventDoc["showtimes"]) => ({ title, missedRuns, showtimes });
    const docs = [
      row("Agbara Nla: The Return", 1, times), row("Agbara Nla", 0, link), // Silverbird stopped: Filmhouse's row now
      row("Hexed", 1, link), row("Hexed", 0, times),                       // Silverbird started: its row has the link
      row("Wire Transfer", 1, times),                                      // not seen, but nothing else has it
      row("Dear Ajayi", 1, []),                                            // not a film row: listings are left alone
      row("Dear Ajayi", 0, link),
    ];
    assert.deepEqual(withoutReplacedFilms(docs).map((d) => `${d.title} ${d.missedRuns}`),
      ["Agbara Nla 0", "Hexed 0", "Wire Transfer 1", "Dear Ajayi 1", "Dear Ajayi 0"]);
  });
});

describe("GET /api/cities", () => {
  test("lists every city with its event count, cacheable", async () => {
    const res = await citiesFn(get("/api/cities"), ctx());
    assert.equal(res.status, 200);
    assert.match(res.headers.get("netlify-cdn-cache-control") ?? "", /s-maxage=/);
    const body = (await res.json()) as CitiesResponse;
    assert.equal(body.defaultCity, "winnipeg");
    const counts = Object.fromEntries(body.cities.map((c) => [c.slug, c.count]));
    assert.deepEqual([counts.winnipeg, counts.calgary, counts.toronto], [3, 1, 0]);
    assert.equal(body.cities.length, 17);
    const lagos = body.cities.find((c) => c.slug === "lagos");
    assert.deepEqual([lagos?.country, lagos?.currency, lagos?.timezone], ["NG", "NGN", "Africa/Lagos"]);
    const calgary = body.cities.find((c) => c.slug === "calgary");
    assert.deepEqual([calgary?.name, calgary?.timezone], ["Calgary", "America/Edmonton"]);
  });
});

describe("ticket links", () => {
  const TM = "https://www.ticketmaster.ca/holiday-jazz-night/event/0B00613E";
  const EB = "https://www.eventbrite.ca/e/winter-market-tickets-123456789";

  test("seller pages get one; listing sites and junk don't", () => {
    delete process.env.AFFILIATE_LINKS;
    assert.deepEqual(ticketsFor(TM), { url: TM, seller: "Ticketmaster", affiliate: false });
    assert.equal(ticketsFor(EB)?.seller, "Eventbrite");
    assert.equal(ticketsFor("https://allevents.in/winnipeg/bombay-nights/1000020"), null);
    assert.equal(ticketsFor("https://www.eventbrite.co.uk/e/fundraiser-tickets-2004790074079")?.seller, "Eventbrite");
    assert.equal(ticketsFor("https://www.ticketmaster.com.au/event/1")?.seller, "Ticketmaster");
    assert.equal(ticketsFor("https://notticketmaster.ca/x"), null); // look-alikes aren't the seller
    assert.equal(ticketsFor("https://ticketmaster.ca.example.com/x"), null);
    assert.equal(ticketsFor("https://www.ticketweb.ca/event/x")?.seller, "TicketWeb");
    assert.equal(ticketsFor("https://tix.africa/discover/afrobeats-night")?.seller, "Tix Africa");
    assert.equal(ticketsFor("https://tinyurl.com/abc", true)?.seller, "the organizer’s site");
    assert.equal(ticketsFor("https://tinyurl.com/abc"), null); // only when a listing named it
    assert.equal(ticketsFor("javascript:alert(1)"), null);
    assert.equal(ticketsFor(""), null);
  });

  test("AFFILIATE_LINKS wraps that seller's links only, and a bad value is ignored", () => {
    process.env.AFFILIATE_LINKS = JSON.stringify({ "ticketmaster.ca": "https://aff.example/c/1/2/3?u={url}", "eventbrite.ca": "http://not-https/{url}" });
    try {
      assert.deepEqual(ticketsFor(TM), { url: `https://aff.example/c/1/2/3?u=${encodeURIComponent(TM)}`, seller: "Ticketmaster", affiliate: true });
      assert.deepEqual(ticketsFor(EB), { url: EB, seller: "Eventbrite", affiliate: false });
      process.env.AFFILIATE_LINKS = "{not json";
      assert.equal(ticketsFor(TM)?.affiliate, false);
    } finally {
      delete process.env.AFFILIATE_LINKS;
    }
  });

  test("the API includes them", async () => {
    const res = await eventFn(get(`/api/events/${ID.music}`), ctx({ id: ID.music }));
    const music = (await res.json()) as ApiEvent;
    assert.deepEqual(music.tickets, { url: music.url, seller: "Ticketmaster", affiliate: false });
    const film = (await (await eventFn(get(`/api/events/${ID.film}`), ctx({ id: ID.film }))).json()) as ApiEvent;
    assert.equal(film.tickets, null);
    // films are bought per showing; showtimes saved before ticket links have one empty link per time
    assert.deepEqual(film.showtimes[0].tickets, ["", ""]);
  });

  test("a listing's named seller is used, even on a site we don't know", async () => {
    const res = await eventFn(get(`/api/events/${ID.calgary}`), ctx({ id: ID.calgary }));
    const e = (await res.json()) as ApiEvent;
    assert.deepEqual(e.tickets, { url: "https://www.winterfest.example/tickets", seller: "winterfest.example", affiliate: false });
    const [inFeed] = ((await (await eventsFn(get("/api/events?city=calgary"), ctx())).json()) as EventsResponse).events;
    assert.ok(validateEvent(inFeed), JSON.stringify(validateEvent.errors));
  });
});

describe("POST /api/interactions and /api/me", () => {
  const deviceId = randomUUID();
  const item = (eventId: string, action: string, minutesAgo: number, context: object = {}) =>
    ({ id: randomUUID(), eventId, action, at: new Date(Date.now() - minutesAgo * 60_000).toISOString(), context });

  test("stores a batch, fills in the category, and ignores a resend", async () => {
    const batch = { deviceId, items: [item(ID.music, "view", 5, { position: 0 }), item(ID.music, "save", 4, { via: "swipe" })] };
    const res = await interactionsFn(post("/api/interactions", batch), ctx());
    assert.equal(res.status, 202);
    assert.deepEqual(await res.json(), { accepted: 2, rejected: 0 });
    await interactionsFn(post("/api/interactions", batch), ctx()); // retried upload
    const stored = await db.collection("interactions").find({ deviceId }).toArray();
    assert.equal(stored.length, 2);
    assert.equal(stored[0].category, "Music & Concerts");
  });

  test("rejects unknown events and malformed items, and bad batches outright", async () => {
    const res = await interactionsFn(post("/api/interactions", {
      deviceId, items: [item("evt_ffffffffffffffff", "save", 1), { id: "x", action: "save" }, item(ID.film, "jump", 1)],
    }), ctx());
    assert.deepEqual(await res.json(), { accepted: 0, rejected: 3 });
    assert.equal((await interactionsFn(post("/api/interactions", { deviceId: "me", items: [] }), ctx())).status, 400);
    assert.equal((await interactionsFn(post("/api/interactions", "{not json"), ctx())).status, 400);
    const tooMany = { deviceId, items: Array.from({ length: 51 }, () => item(ID.music, "view", 1)) };
    assert.equal((await interactionsFn(post("/api/interactions", tooMany), ctx())).status, 400);
  });

  test("tracks state: undo restores, and a late batch can't overwrite a newer swipe", async () => {
    await interactionsFn(post("/api/interactions", {
      deviceId, items: [item(ID.film, "pass", 3), item(ID.film, "undo", 2, { restoredState: null }), item(ID.later, "later", 2)],
    }), ctx());
    await interactionsFn(post("/api/interactions", { deviceId, items: [item(ID.music, "pass", 30)] }), ctx()); // older than the save
    const res = await meFn(get("/api/me/state", { "x-device-id": deviceId }), ctx());
    const { states } = (await res.json()) as StateResponse;
    const byEvent = Object.fromEntries(states.map((s) => [s.eventId, s.state]));
    assert.deepEqual(byEvent, { [ID.music]: "saved", [ID.later]: "later" });
  });

  test("an unreachable database is a quick 503, not a hang or a 500", async () => {
    await closeDb();
    const uri = process.env.MONGODB_URI;
    process.env.MONGODB_URI = "mongodb://127.0.0.1:1"; // nothing listens there
    const started = Date.now();
    const res = await eventsFn(get("/api/events"), ctx());
    process.env.MONGODB_URI = uri;
    db = await getDb();
    assert.equal(res.status, 503);
    assert.ok(Date.now() - started < 8000, `took ${Date.now() - started} ms`);
  });

  test("GET /api/me/export has everything stored for the device, with event titles, and nothing else", async () => {
    const other = randomUUID();
    await interactionsFn(post("/api/interactions", { deviceId: other, items: [item(ID.music, "view", 1)] }), ctx());
    const res = await meFn(get("/api/me/export", { "x-device-id": deviceId }), ctx());
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const data = (await res.json()) as {
      deviceId: string; interactions: { eventId: string; event: string | null; action: string }[];
      states: { eventId: string; state: string | null }[]; cityRequests: unknown[];
    };
    assert.equal(data.deviceId, deviceId);
    assert.equal(data.interactions.length, await db.collection("interactions").countDocuments({ deviceId }));
    assert.equal(data.interactions[0].event, `Event ${ID.music}`);
    assert.equal(data.states.length, 3);
    assert.ok(!JSON.stringify(data).includes(other));
  });

  test("DELETE /api/me removes everything for the device", async () => {
    assert.equal((await meFn(get("/api/me/state"), ctx())).status, 400);
    const res = await meFn(new Request(`${BASE}/api/me`, { method: "DELETE", headers: { "x-device-id": deviceId } }), ctx());
    const { deleted } = (await res.json()) as { deleted: { interactions: number; states: number } };
    assert.ok(deleted.interactions >= 5 && deleted.states === 3, JSON.stringify(deleted));
    assert.equal(await db.collection("interactions").countDocuments({ deviceId }), 0);
  });
});

describe("keeping data", () => {
  test("nothing people stored expires, and the old expiry indexes are dropped", async () => {
    await db.collection("interactions").createIndex({ receivedAt: 1 }, { name: "expire", expireAfterSeconds: 540 * 86400 });
    await db.collection("cityRequestLog").createIndex({ at: 1 }, { name: "expire", expireAfterSeconds: 90 * 86400 });
    await setupIndexes(db);
    await setupIndexes(db); // and again, with nothing left to drop
    for (const name of ["interactions", "userEventState", "cityRequestLog", "cityRequests", "suggestions"]) {
      const ttl = (await db.collection(name).indexes()).filter((i) => i.expireAfterSeconds !== undefined);
      assert.deepEqual(ttl, [], name);
    }
  });
});

describe("going, did you go, and popularity", () => {
  const item = (eventId: string, action: string, context: object = {}) =>
    ({ id: randomUUID(), eventId, action, at: new Date(Date.now() - 60_000).toISOString(), context });
  const devices = Array.from({ length: 14 }, () => randomUUID());
  const send = (deviceId: string, items: object[]) => interactionsFn(post("/api/interactions", { deviceId, items }), ctx());

  test("going, an answer and a rating are recorded; without their value they're dropped", async () => {
    const res = await send(devices[0], [
      item(ID.music, "going"), item(ID.music, "attended", { answer: "yes" }), item(ID.music, "rated", { rating: "up" }),
      item(ID.music, "attended"), item(ID.music, "rated", { rating: "meh" }),
    ]);
    assert.deepEqual(await res.json(), { accepted: 3, rejected: 2 });
  });

  test("counts people, not taps; shows counts only from 10 people; marks the city's top events popular", async () => {
    // 12 people save the jazz night and most say they're going (one taps tickets three times); 10 save the later
    // event; 3 save the film
    for (const [i, d] of devices.slice(0, 12).entries()) {
      await send(d, [item(ID.music, "view"), item(ID.music, "save"), ...(i < 10 ? [item(ID.music, "going")] : [])]);
    }
    await send(devices[1], [item(ID.music, "tickets"), item(ID.music, "tickets"), item(ID.music, "tickets")]);
    await send(devices[11], [item(ID.music, "not_going")]);
    for (const d of devices.slice(2, 12)) await send(d, [item(ID.later, "save")]);
    for (const d of devices.slice(0, 3)) await send(d, [item(ID.film, "save")]);

    const result = await computeStats(db);
    assert.ok(result.withActivity >= 3 && result.popular === 1, JSON.stringify(result));
    const music = await db.collection("eventStats").findOne({ _id: ID.music as never });
    assert.equal(music?.people.tickets, 1);
    assert.equal(music?.people.going, 10);
    assert.equal(music?.attended.yes, 1);

    const feed = (await (await eventsFn(get("/api/events"), ctx())).json()) as EventsResponse;
    const pop = Object.fromEntries(feed.events.map((e) => [e.id, e.popularity]));
    assert.deepEqual(pop[ID.music], { interested: 12, going: 10, popular: true });
    assert.deepEqual(pop[ID.later], { interested: MIN_PEOPLE, going: null, popular: false });
    assert.equal(pop[ID.film], null);
    for (const e of feed.events) assert.ok(validateEvent(e), JSON.stringify(validateEvent.errors));
  });

  test("an event's stats go once nobody's data is left", async () => {
    for (const d of devices) {
      await meFn(new Request(`${BASE}/api/me`, { method: "DELETE", headers: { "x-device-id": d } }), ctx());
    }
    await computeStats(db);
    // only these devices acted on the later event and the film (an earlier test's device viewed the jazz night)
    assert.equal(await db.collection("eventStats").countDocuments({ _id: { $in: [ID.later, ID.film] as never[] } }), 0);
    const music = await db.collection("eventStats").findOne({ _id: ID.music as never });
    assert.deepEqual([music?.people.seen, music?.people.saved, music?.popular], [1, 0, false]);
  });
});

describe("reminders", () => {
  const WPG = "America/Winnipeg";
  const timed = { title: "Holiday Jazz Night", startLocal: "2026-12-05T19:30", allDay: false, tags: [], showtimes: [],
    venue: { name: "Park Theatre", address: "" }, start: zonedTime("2026-12-05", "19:30", WPG) };

  test("6 pm the day before and 2 hours before; 9 am for a date-only event; none at night, for films or exhibitions", () => {
    assert.equal(timed.start.toISOString(), "2026-12-06T01:30:00.000Z");
    const [day, soon] = remindersFor(timed, WPG);
    assert.deepEqual([day.kind, day.at.toISOString(), day.title, day.body],
      ["day", "2026-12-05T00:00:00.000Z", "Tomorrow: Holiday Jazz Night", "7:30 pm · Park Theatre"]);
    assert.deepEqual([soon.kind, soon.at.toISOString()], ["soon", "2026-12-05T23:30:00.000Z"]);
    const early = { ...timed, startLocal: "2026-12-05T07:00", start: zonedTime("2026-12-05", "07:00", WPG) };
    assert.deepEqual(remindersFor(early, WPG).map((r) => r.kind), ["day"]); // 5 am is too early
    const market = { ...timed, startLocal: "2026-12-05", allDay: true };
    assert.deepEqual(remindersFor(market, WPG).map((r) => [r.kind, r.at.toISOString()]), [["today", "2026-12-05T15:00:00.000Z"]]);
    assert.deepEqual(remindersFor({ ...timed, tags: ["ongoing"] }, WPG), []);
    // across the spring clock change, and in Lagos
    assert.equal(zonedTime("2026-03-08", "18:00", WPG).toISOString(), "2026-03-08T23:00:00.000Z");
    assert.equal(zonedTime("2026-12-04", "18:00", "Africa/Lagos").toISOString(), "2026-12-04T17:00:00.000Z");
  });

  const deviceId = randomUUID();
  const sub = { endpoint: "https://fcm.googleapis.com/fcm/send/abc123", keys: { p256dh: "B".repeat(87), auth: "a".repeat(22) } };
  const put = (body: unknown) => new Request(`${BASE}/api/reminders`, {
    method: "PUT", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

  test("off until the keys are set; then a device subscribes, only through a real push service", async () => {
    assert.equal((await remindersFn(get("/api/reminders/key"), ctx())).status, 404);
    assert.equal((await remindersFn(put({ deviceId, subscription: sub, events: [ID.music] }), ctx())).status, 404);
    const keys = webpush.generateVAPIDKeys();
    process.env.VAPID_PUBLIC_KEY = keys.publicKey;
    process.env.VAPID_PRIVATE_KEY = keys.privateKey;
    const key = (await (await remindersFn(get("/api/reminders/key"), ctx())).json()) as { publicKey: string };
    assert.equal(key.publicKey, keys.publicKey);

    const elsewhere = { ...sub, endpoint: "https://169.254.169.254/latest" };
    assert.equal((await remindersFn(put({ deviceId, subscription: elsewhere, events: [] }), ctx())).status, 400);
    assert.equal((await remindersFn(put({ deviceId, subscription: sub, events: ["nope"] }), ctx())).status, 400);
    const res = await remindersFn(put({ deviceId, subscription: sub, events: [ID.music, ID.later] }), ctx());
    assert.deepEqual(await res.json(), { events: 2 });

    // a reminder already sent stays sent while its event is still listed
    await db.collection<ReminderDoc>("reminders").updateOne({ _id: deviceId }, { $set: { sent: [`${ID.music}:day`, `${ID.later}:day`] } });
    await remindersFn(put({ deviceId, subscription: sub, events: [ID.music] }), ctx());
    const doc = await db.collection<ReminderDoc>("reminders").findOne({ _id: deviceId });
    assert.deepEqual([doc?.events, doc?.sent], [[ID.music], [`${ID.music}:day`]]);

    const exported = await (await meFn(get("/api/me/export", { "x-device-id": deviceId }), ctx())).json() as { reminders: { pushService: string } };
    assert.equal(exported.reminders.pushService, "fcm.googleapis.com");
    const del = await meFn(new Request(`${BASE}/api/me`, { method: "DELETE", headers: { "x-device-id": deviceId } }), ctx());
    assert.equal(((await del.json()) as { deleted: { reminders: number } }).deleted.reminders, 1);
  });

  test("each due reminder goes out once, in its window; a subscription that's gone is removed", async () => {
    const id = "evt_00000000000000c1";
    await db.collection<EventDoc>("events").insertOne(eventDoc(id, { ...timed, city: "winnipeg", visibleUntil: new Date(timed.start.getTime() + 6 * HOUR) }));
    const reminders = db.collection<ReminderDoc>("reminders");
    const now = new Date();
    await reminders.insertMany([
      { _id: "d1", subscription: sub, events: [id], sent: [], createdAt: now, updatedAt: now },
      { _id: "d2", subscription: { ...sub, endpoint: `${sub.endpoint}-gone` }, events: [id], sent: [], createdAt: now, updatedAt: now },
    ]);
    const sent: string[] = [];
    const sender: Sender = async (s, payload) => {
      if (s.endpoint.endsWith("-gone")) throw Object.assign(new Error("Gone"), { statusCode: 410 });
      sent.push(JSON.parse(payload).tag);
    };
    const at = (iso: string) => new Date(iso);
    assert.deepEqual(await sendReminders(db, sender, at("2026-12-04T23:50:00Z")), { sent: 0, failed: 0, removed: 0 }); // too early
    assert.deepEqual(await sendReminders(db, sender, at("2026-12-05T00:05:00Z")), { sent: 1, failed: 0, removed: 1 });
    assert.deepEqual(await sendReminders(db, sender, at("2026-12-05T00:20:00Z")), { sent: 0, failed: 0, removed: 0 }); // sent already
    assert.deepEqual(await sendReminders(db, sender, at("2026-12-05T23:31:00Z")), { sent: 1, failed: 0, removed: 0 });
    assert.deepEqual(await sendReminders(db, sender, at("2026-12-06T02:00:00Z")), { sent: 0, failed: 0, removed: 0 }); // it's on
    assert.deepEqual(sent, [`${id}:day`, `${id}:soon`]);
    assert.equal(await reminders.countDocuments({ _id: "d2" }), 0);
    const day = await db.collection("tallies").findOne({ _id: "2026-12-05" as never });
    assert.equal(day?.reminders_sent, 2);
    await reminders.deleteMany({});
    await db.collection("events").deleteOne({ _id: id as never });
  });
});

describe("POST /api/tally", () => {
  test("counts an answer for the day, with nothing about who", async () => {
    const res = await tallyFn(post("/api/tally", { tally: "consent_yes" }), ctx());
    assert.equal(res.status, 204);
    assert.equal((await tallyFn(post("/api/tally", { tally: "deviceId" }), ctx())).status, 400);
    const today = await db.collection("tallies").findOne({ _id: new Date().toISOString().slice(0, 10) as never });
    assert.deepEqual(Object.keys(today ?? {}).sort(), ["_id", "consent_yes"]);
  });
});

describe("finding and requesting cities", () => {
  const place = (id: number, name: string, country: string, countryName: string, region: string, lat: number, lon: number,
    population: number): PlaceDoc => ({
    _id: id, name, ascii: name, key: name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(), region, country, countryName,
    currency: country === "NG" ? "NGN" : "CAD", timezone: country === "NG" ? "Africa/Lagos" : "America/Toronto", population,
    lat, lon, location: { type: "Point", coordinates: [lon, lat] },
  });
  const PLACES = {
    winnipeg: place(6183235, "Winnipeg", "CA", "Canada", "Manitoba", 49.88, -97.15, 705244),
    waterloo: place(6176823, "Waterloo", "CA", "Canada", "Ontario", 43.47, -80.52, 104986),
    abeokuta: place(2352947, "Abeokuta", "NG", "Nigeria", "Ogun State", 7.16, 3.35, 735000),
    lagosNg: place(2332459, "Lagos", "NG", "Nigeria", "Lagos", 6.45, 3.39, 15388000),
    lagosPt: place(2267226, "Lagos", "PT", "Portugal", "Faro", 37.1, -8.67, 33494),
  };
  const deviceId = randomUUID();
  const search = async (q: string) => ((await (await placesFn(get(`/api/places?q=${encodeURIComponent(q)}`), ctx())).json()) as PlacesResponse).places;
  const ask = async (placeId: unknown, device = deviceId) => cityRequestsFn(post("/api/city-requests", { deviceId: device, placeId }), ctx());

  before(async () => {
    await db.collection<PlaceDoc>("places").insertMany(Object.values(PLACES));
    forgetLiveCities();
  });

  test("names normalize as the crawler's norm() does", () => {
    // crawler/tests/test_load_to_mongo.py checks events.norm against the same pairs
    const pairs = [["St. John's", "st johns"], ["Montréal", "montreal"], ["Kitchener-Waterloo", "kitchener waterloo"],
      ["  Québec   City ", "quebec city"], ["Ōsaka", "osaka"]];
    for (const [name, key] of pairs) assert.equal(normalizeName(name), key);
  });

  test("search: covered cities first, one entry each; other places by size", async () => {
    assert.deepEqual((await search("Winn")).map((p) => [p.name, p.city]), [["Winnipeg", "winnipeg"]]);
    // Kitchener-Waterloo by its own name, and Waterloo (the place) as part of it: one entry
    assert.deepEqual((await search("kitch")).map((p) => p.city), ["kitchener-waterloo"]);
    assert.deepEqual((await search("waterloo")).map((p) => [p.name, p.city]), [["Waterloo", "kitchener-waterloo"]]);
    const lagos = await search("lagos");
    assert.deepEqual(lagos.map((p) => [p.name, p.country, p.city]), [["Lagos", "NG", "lagos"], ["Lagos", "PT", null]]);
    assert.deepEqual((await search("abeo")).map((p) => [p.name, p.region, p.city, p.request]), [["Abeokuta", "Ogun State", null, null]]);
    assert.deepEqual(await search("a"), []); // too short
  });

  test("nearest: the place and the nearest covered city, from a rounded position", async () => {
    const res = await placesFn(get("/api/places/nearest?lat=7.1612&lon=3.3488"), ctx());
    assert.equal(res.headers.get("cache-control"), "no-store");
    const near = (await res.json()) as NearestResponse;
    assert.deepEqual([near.place?.name, near.place?.city, near.city?.slug], ["Abeokuta", null, "lagos"]);
    assert.ok(near.city && near.city.km > 60 && near.city.km < 100, `${near.city?.km} km`);
    const home = (await (await placesFn(get("/api/places/nearest?lat=49.9&lon=-97.1"), ctx())).json()) as NearestResponse;
    assert.equal(home.place?.city, "winnipeg");
    assert.equal((await placesFn(get("/api/places/nearest?lat=north"), ctx())).status, 400);
  });

  test("a request: covered places say so; a new city is logged once per device and waits for its crawl", async () => {
    assert.deepEqual(await (await ask(PLACES.waterloo._id)).json(), { status: "covered", city: "kitchener-waterloo", name: "Kitchener-Waterloo" });
    const first = (await (await ask(PLACES.abeokuta._id)).json()) as CityRequestResponse;
    assert.deepEqual(first, { status: "pending", city: "abeokuta-ng", name: "Abeokuta" });
    await ask(PLACES.abeokuta._id);                // the same device again
    await ask(PLACES.abeokuta._id, randomUUID());  // someone else
    const doc = await db.collection("cityRequests").findOne({ _id: "abeokuta-ng" as never });
    assert.deepEqual([doc?.requests, doc?.timezone, doc?.currency], [2, "Africa/Lagos", "NGN"]);
    assert.equal((await search("abeo"))[0].request, "pending");
    // a namesake gets its own slug
    assert.equal(((await (await ask(PLACES.lagosPt._id)).json()) as CityRequestResponse).city, "lagos-pt");
    assert.equal((await ask(999)).status, 404);
    assert.equal((await ask("abc")).status, 400);
    assert.equal((await cityRequestsFn(post("/api/city-requests", { deviceId: "me", placeId: 1 }), ctx())).status, 400);
  });

  test("at most five requests a day per device", async () => {
    const busy = randomUUID();
    for (let i = 0; i < 5; i++) assert.equal((await ask(PLACES.abeokuta._id, busy)).status, 200);
    assert.equal((await ask(PLACES.abeokuta._id, busy)).status, 429);
  });

  test("a requested city with enough events goes live: listed, searchable, with a feed", async () => {
    await db.collection("cityRequests").updateOne({ _id: "abeokuta-ng" as never }, { $set: { status: "active", eventCount: 12 } });
    await db.collection<EventDoc>("events").insertOne(eventDoc("evt_00000000000000aa", { city: "abeokuta-ng", url: "https://allevents.in/abeokuta/x" }));
    forgetLiveCities();
    const { cities } = (await (await citiesFn(get("/api/cities"), ctx())).json()) as CitiesResponse;
    const abeokuta = cities.find((c) => c.slug === "abeokuta-ng");
    assert.deepEqual([abeokuta?.name, abeokuta?.currency, abeokuta?.count], ["Abeokuta", "NGN", 1]);
    assert.equal((await search("abeo"))[0].city, "abeokuta-ng");
    const feed = (await (await eventsFn(get("/api/events?city=abeokuta-ng"), ctx())).json()) as EventsResponse;
    assert.deepEqual(feed.events.map((e) => e.id), ["evt_00000000000000aa"]);
  });

  test("Delete my data removes the device's city requests too", async () => {
    const res = await meFn(new Request(`${BASE}/api/me`, { method: "DELETE", headers: { "x-device-id": deviceId } }), ctx());
    const { deleted } = (await res.json()) as { deleted: { cityRequests: number } };
    assert.ok(deleted.cityRequests >= 3, JSON.stringify(deleted));
    assert.equal(await db.collection("cityRequestLog").countDocuments({ deviceId }), 0);
  });
});

describe("suggesting events", () => {
  const deviceId = randomUUID();
  const suggest = (body: object, device: string = deviceId) => suggestionsFn(post("/api/suggestions", { deviceId: device, ...body }), ctx());
  const IG = "https://www.instagram.com/p/DdTtY";

  test("links are cleaned up, so the same post shared twice is one link; anything but a public web page is refused", () => {
    assert.equal(cleanLink(" instagram.com/p/DdTtY/?igsh=MWQ1ZGUxMzBkMA== "), IG);
    assert.equal(cleanLink("https://m.facebook.com/events/123/"), "https://www.facebook.com/events/123");
    assert.equal(cleanLink("https://WWW.Instagram.com/p/DdTtY/?utm_source=ig_web_copy_link#comments"), IG);
    assert.equal(cleanLink("https://tix.africa/discover/afro-fest?ref=home&fbclid=x1"), "https://tix.africa/discover/afro-fest?ref=home");
    assert.equal(cleanLink("https://example.com/"), "https://example.com/");
    for (const bad of ["", "hello", "javascript:alert(1)", "ftp://files.example.com/a", "http://localhost:8888/x",
      "http://192.168.0.1/admin", "http://[::1]/", "https://user:pw@example.com/", "https://two words.com", "https://x".padEnd(2100, "x")]) {
      assert.equal(cleanLink(bad), null, bad);
    }
  });

  test("a link is stored for review, once per device; a resend updates its note", async () => {
    let res = await suggest({ city: "lagos", url: `${IG}/?igsh=abc`, note: "  Sat 20 Dec, 6 pm, Muri Okunola Park " });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.deepEqual(await res.json(), { status: "received" } satisfies SuggestionResponse);
    res = await suggest({ city: "lagos", url: IG, note: "Free before 9" });
    assert.equal(res.status, 200);
    await suggest({ city: "lagos", url: IG }, randomUUID()); // someone else, no note
    const docs = await db.collection<SuggestionDoc>("suggestions").find({ url: IG }).sort({ at: 1 }).toArray();
    assert.equal(docs.length, 2);
    assert.deepEqual([docs[0].deviceId, docs[0].city, docs[0].note, docs[0].status, docs[0].key], [deviceId, "lagos", "Free before 9", "new", linkKey(IG)]);
    assert.equal(docs[1].note, "");
    // nothing about it is public
    const feed = (await (await eventsFn(get("/api/events?city=lagos"), ctx())).json()) as EventsResponse;
    assert.ok(!JSON.stringify(feed).includes("DdTtY"));
  });

  test("a link that's already an event in that city's feed opens it, and nothing is stored", async () => {
    const res = await suggest({ city: "winnipeg", url: "https://www.ticketmaster.ca/holiday-jazz-night/event/0B00613E?utm_source=share" });
    assert.deepEqual(await res.json(), { status: "listed", eventId: ID.music });
    assert.equal(await db.collection("suggestions").countDocuments({ url: /ticketmaster/ }), 0);
    // in another city it's just a suggestion
    assert.equal(((await (await suggest({ city: "calgary", url: "https://www.ticketmaster.ca/holiday-jazz-night/event/0B00613E" })).json()) as SuggestionResponse).status, "received");
  });

  test("refuses a bad device, city, link or note", async () => {
    assert.equal((await suggest({ city: "lagos", url: IG }, "me")).status, 400);
    assert.equal((await suggest({ city: "atlantis", url: IG })).status, 400);
    assert.equal((await suggest({ url: IG })).status, 400);
    assert.equal((await suggest({ city: "lagos", url: "not a link" })).status, 400);
    assert.equal((await suggest({ city: "lagos", url: IG, note: "x".repeat(501) })).status, 400);
    assert.equal((await suggest({ city: "lagos", url: IG, note: 5 })).status, 400);
    assert.equal((await suggestionsFn(get("/api/suggestions"), ctx())).status, 405);
  });

  test("ten new links a day per device; the same link again doesn't count", async () => {
    const busy = randomUUID();
    for (let i = 0; i < 10; i++) assert.equal((await suggest({ city: "abuja", url: `https://shop.example.ng/e/${i}` }, busy)).status, 200);
    assert.equal((await suggest({ city: "abuja", url: "https://shop.example.ng/e/10" }, busy)).status, 429);
    assert.equal((await suggest({ city: "abuja", url: "https://shop.example.ng/e/3", note: "Sunday" }, busy)).status, 200);
  });

  test("they're in Download my data, and Delete my data removes them", async () => {
    const data = (await (await meFn(get("/api/me/export", { "x-device-id": deviceId }), ctx())).json()) as {
      suggestions: { city: string; url: string; note: string; status: string }[];
    };
    assert.deepEqual(data.suggestions.map((x) => [x.city, x.url, x.note, x.status]).sort(),
      [["calgary", "https://www.ticketmaster.ca/holiday-jazz-night/event/0B00613E", "", "new"], ["lagos", IG, "Free before 9", "new"]]);
    const res = await meFn(new Request(`${BASE}/api/me`, { method: "DELETE", headers: { "x-device-id": deviceId } }), ctx());
    const { deleted } = (await res.json()) as { deleted: { suggestions: number } };
    assert.equal(deleted.suggestions, 2);
    assert.equal(await db.collection("suggestions").countDocuments({ deviceId }), 0);
    assert.equal(await db.collection("suggestions").countDocuments({ url: IG }), 1); // the other device's
  });
});
