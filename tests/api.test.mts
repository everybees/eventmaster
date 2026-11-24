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
import type { ApiEvent, CitiesResponse, EventsResponse, StateResponse } from "../shared/types.ts";
import { closeDb, getDb } from "../netlify/lib/db.mts";
import { setupIndexes } from "../netlify/lib/indexes.mts";
import { soonestShowtimes, todayIn, type EventDoc } from "../netlify/lib/models.mts";
import { ticketsFor } from "../netlify/lib/tickets.mts";
import eventsFn from "../netlify/functions/events.mts";
import eventFn from "../netlify/functions/event.mts";
import citiesFn from "../netlify/functions/cities.mts";
import interactionsFn from "../netlify/functions/interactions.mts";
import meFn from "../netlify/functions/me.mts";

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
    // 03:45 UTC on Nov 24 is still Nov 23 in Winnipeg and Vancouver, but 00:15 on Nov 24 in St. John's (UTC-3:30)
    const at = new Date("2026-11-24T03:45:00Z");
    assert.deepEqual([todayIn("America/Winnipeg", at), todayIn("America/Vancouver", at), todayIn("America/St_Johns", at)],
      ["2026-11-23", "2026-11-23", "2026-11-24"]);
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

  test("DELETE /api/me removes everything for the device", async () => {
    assert.equal((await meFn(get("/api/me/state"), ctx())).status, 400);
    const res = await meFn(new Request(`${BASE}/api/me`, { method: "DELETE", headers: { "x-device-id": deviceId } }), ctx());
    const { deleted } = (await res.json()) as { deleted: { interactions: number; states: number } };
    assert.ok(deleted.interactions >= 5 && deleted.states === 3, JSON.stringify(deleted));
    assert.equal(await db.collection("interactions").countDocuments({ deviceId }), 0);
  });
});
