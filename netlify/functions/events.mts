import type { Config } from "@netlify/functions";
import type { Filter } from "mongodb";
import type { EventsResponse } from "../../shared/types.ts";
import { cityFilter, DEFAULT_CITY, isCity } from "../lib/cities.mts";
import { getDb } from "../lib/db.mts";
import { error, FEED_CACHE, handler, json } from "../lib/http.mts";
import { toApiEvent, type EventDoc } from "../lib/models.mts";

const DEFAULT_LIMIT = 300;
const MAX_LIMIT = 500;

/**
 * GET /api/events — a city's feed: every active event still on (or ahead), soonest first.
 *   ?city=calgary (default: the first city)  ?category=Movies%20%26%20Film  ?tag=family
 *   ?from=2026-11-28  ?to=2026-11-30  ?limit=100
 */
export default handler(async (req) => {
  if (req.method !== "GET") return error(405, "Use GET");
  const q = new URL(req.url).searchParams;
  const from = parseDate(q.get("from"));
  const to = parseDate(q.get("to"));
  if (from === null || to === null) return error(400, "from and to must be dates, e.g. 2026-11-28");
  const city = q.get("city") || DEFAULT_CITY;
  if (!isCity(city)) return error(400, "Unknown city; GET /api/cities lists them");

  const now = new Date();
  const filter: Filter<EventDoc> = {
    city: cityFilter(city),
    status: "active",
    visibleUntil: { $gte: from && from > now ? from : now }, // still running at (or after) `from`
  };
  if (to) filter.start = { $lte: to };
  const category = q.get("category");
  if (category) filter.category = category;
  const tag = q.get("tag");
  if (tag) filter.tags = tag;
  const limit = Math.min(Math.max(Number.parseInt(q.get("limit") ?? "", 10) || DEFAULT_LIMIT, 1), MAX_LIMIT);

  const db = await getDb();
  const docs = await db.collection<EventDoc>("events").find(filter).sort({ start: 1, _id: 1 }).limit(limit).toArray();
  const body: EventsResponse = { city, generatedAt: now.toISOString(), count: docs.length, events: docs.map(toApiEvent) };
  return json(body, { headers: FEED_CACHE });
});

/** undefined when absent, null when present but not a date. */
function parseDate(value: string | null): Date | null | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export const config: Config = { path: "/api/events" };
