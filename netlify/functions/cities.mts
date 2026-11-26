import type { Config } from "@netlify/functions";
import type { CitiesResponse } from "../../shared/types.ts";
import { DEFAULT_CITY, liveCities } from "../lib/cities.mts";
import { getDb } from "../lib/db.mts";
import { error, FEED_CACHE, handler, json } from "../lib/http.mts";
import type { EventDoc } from "../lib/models.mts";

/** GET /api/cities — every city the app covers (including requested ones that went live), with how many
 *  events each has in its feed now. */
export default handler(async (req) => {
  if (req.method !== "GET") return error(405, "Use GET");
  const db = await getDb();
  const rows = await db.collection<EventDoc>("events").aggregate<{ _id: string | null; n: number }>([
    { $match: { status: "active", visibleUntil: { $gte: new Date() } } },
    { $group: { _id: "$city", n: { $sum: 1 } } },
  ]).toArray();
  const counts = new Map<string, number>();
  for (const { _id, n } of rows) {
    const slug = _id ?? DEFAULT_CITY; // from before cities
    counts.set(slug, (counts.get(slug) ?? 0) + n);
  }
  const body: CitiesResponse = {
    defaultCity: DEFAULT_CITY,
    cities: (await liveCities(db)).map((c) => ({ ...c, count: counts.get(c.slug) ?? 0 })),
  };
  return json(body, { headers: FEED_CACHE });
});

export const config: Config = { path: "/api/cities" };
