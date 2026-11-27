import type { Db } from "mongodb";
import type { Answer, Popularity, Rating } from "../../shared/types.ts";
import { DEFAULT_CITY } from "./cities.mts";
import type { EventDoc, StateDoc } from "./models.mts";

/** Below this many people, an event shows no counts: small numbers say little and could point at someone. */
export const MIN_PEOPLE = 10;
/** The share of a city's current events with enough people that are marked popular (at least one). */
const POPULAR_SHARE = 0.1;
/** Added to the people who saw an event, so a few enthusiastic early people don't top the list. */
const PRIOR_PEOPLE = 10;
/** What each kind of interest is worth, per person. */
const WEIGHTS = { details: 1, map: 2, saved: 3, share: 4, calendar: 4, tickets: 5, going: 6, attendedYes: 6, up: 2, down: -3 };

/** An `eventStats` document: one per event anyone acted on, recomputed by the hourly job. Counts are people
 *  (devices that share their activity), never taps. Titles are copied so the stats outlive the event. */
export interface StatsDoc {
  _id: string;
  city: string;
  title: string;
  category: string;
  venue: string;
  startLocal: string;
  people: {
    seen: number; details: number; saved: number; going: number; tickets: number; calendar: number; share: number;
    map: number; interested: number;
  };
  attended: Record<Answer, number>;
  rating: Record<Rating, number>;
  score: number;
  popular: boolean;
  updatedAt: Date;
}

interface Person {
  details: boolean; tickets: boolean; calendar: boolean; share: boolean; map: boolean; saved: boolean;
  goingAt?: Date; notGoingAt?: Date; answer?: Answer; rating?: Rating;
}

const blank = (): Person => ({ details: false, tickets: false, calendar: false, share: false, map: false, saved: false });

/** Recomputes every event's stats from the interactions and saved states. */
export async function computeStats(db: Db, now = new Date()): Promise<{ events: number; withActivity: number; popular: number }> {
  const events = await db.collection<EventDoc>("events")
    .find({}, { projection: { city: 1, title: 1, category: 1, venue: 1, startLocal: 1, status: 1, visibleUntil: 1 } })
    .toArray();
  const ids = events.map((e) => e._id);

  // each person's latest action of each kind, per event
  const rows = await db.collection("interactions").aggregate<{
    _id: { e: string; d: string; a: string }; at: Date; answer?: Answer; rating?: Rating;
  }>([
    { $match: { eventId: { $in: ids } } },
    { $sort: { at: 1 } },
    { $group: { _id: { e: "$eventId", d: "$deviceId", a: "$action" }, at: { $last: "$at" },
      answer: { $last: "$context.answer" }, rating: { $last: "$context.rating" } } },
  ], { allowDiskUse: true }).toArray();
  const saved = await db.collection<StateDoc>("userEventState")
    .find({ "_id.e": { $in: ids }, state: "saved" }, { projection: { _id: 1 } }).toArray();

  const people = new Map<string, Map<string, Person>>();
  const person = (e: string, d: string): Person => {
    let byDevice = people.get(e);
    if (!byDevice) people.set(e, (byDevice = new Map()));
    let p = byDevice.get(d);
    if (!p) byDevice.set(d, (p = blank()));
    return p;
  };
  for (const r of rows) {
    const p = person(r._id.e, r._id.d);
    switch (r._id.a) {
      case "details": case "tickets": case "calendar": case "share": case "map":
        p[r._id.a] = true; break;
      case "going": p.goingAt = r.at; break;
      case "not_going": p.notGoingAt = r.at; break;
      case "attended": p.answer = r.answer; break;
      case "rated": p.rating = r.rating; break;
    }
  }
  for (const s of saved) person(s._id.e, s._id.u).saved = true;

  const docs: StatsDoc[] = [];
  for (const e of events) {
    const byDevice = people.get(e._id);
    if (!byDevice) continue;
    const c = { seen: byDevice.size, details: 0, saved: 0, going: 0, tickets: 0, calendar: 0, share: 0, map: 0, interested: 0 };
    const attended: Record<Answer, number> = { yes: 0, no: 0, cancelled: 0 };
    const rating: Record<Rating, number> = { up: 0, down: 0 };
    for (const p of byDevice.values()) {
      const going = Boolean(p.goingAt && (!p.notGoingAt || p.goingAt > p.notGoingAt));
      for (const k of ["details", "saved", "tickets", "calendar", "share", "map"] as const) if (p[k]) c[k]++;
      if (going) c.going++;
      if (p.saved || going || p.tickets || p.calendar || p.share) c.interested++;
      if (p.answer) attended[p.answer]++;
      if (p.rating) rating[p.rating]++;
    }
    const points = WEIGHTS.details * c.details + WEIGHTS.map * c.map + WEIGHTS.saved * c.saved + WEIGHTS.share * c.share
      + WEIGHTS.calendar * c.calendar + WEIGHTS.tickets * c.tickets + WEIGHTS.going * c.going
      + WEIGHTS.attendedYes * attended.yes + WEIGHTS.up * rating.up + WEIGHTS.down * rating.down;
    docs.push({
      _id: e._id, city: e.city ?? DEFAULT_CITY, title: e.title, category: e.category, venue: e.venue?.name ?? "",
      startLocal: e.startLocal, people: c, attended, rating, score: points / (c.seen + PRIOR_PEOPLE), popular: false, updatedAt: now,
    });
  }

  // popular: the top tenth of each city's current events that enough people showed interest in
  const current = new Set(events.filter((e) => e.status === "active" && e.visibleUntil >= now).map((e) => e._id));
  const byCity = new Map<string, StatsDoc[]>();
  for (const d of docs) {
    if (!current.has(d._id) || d.people.interested < MIN_PEOPLE) continue;
    byCity.set(d.city, [...(byCity.get(d.city) ?? []), d]);
  }
  let popular = 0;
  for (const list of byCity.values()) {
    list.sort((a, b) => b.score - a.score);
    for (const d of list.slice(0, Math.max(1, Math.round(list.length * POPULAR_SHARE)))) {
      d.popular = true;
      popular++;
    }
  }

  const col = db.collection<StatsDoc>("eventStats");
  if (docs.length) {
    await col.bulkWrite(docs.map((d) => ({ replaceOne: { filter: { _id: d._id }, replacement: d, upsert: true } })), { ordered: false });
  }
  // current events nobody has acted on any more (after "Delete my data", say); past events' stats stay as history
  await col.deleteMany({ _id: { $in: ids.filter((id) => !people.has(id)) } });
  return { events: events.length, withActivity: docs.length, popular };
}

/** The popularity to show for each of these events that enough people showed interest in. Never fails the
 *  feed: without stats (no job run yet, or no permission), events just have none. */
export async function popularityFor(db: Db, ids: string[]): Promise<Map<string, Popularity>> {
  try {
    const docs = await db.collection<StatsDoc>("eventStats")
      .find({ _id: { $in: ids }, "people.interested": { $gte: MIN_PEOPLE } }, { projection: { people: 1, popular: 1 } })
      .toArray();
    return new Map(docs.map((d) => [d._id, {
      interested: d.people.interested,
      going: d.people.going >= MIN_PEOPLE ? d.people.going : null,
      popular: d.popular,
    }]));
  } catch (err) {
    console.error("Event stats unavailable:", err);
    return new Map();
  }
}
