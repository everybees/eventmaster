import type { Db } from "mongodb";
import cities from "../../shared/cities.json" with { type: "json" };
import type { City } from "../../shared/types.ts";
import type { CityRequestDoc } from "./places.mts";

type Slug = keyof typeof cities;
export type CityInfo = Omit<City, "count">;

export const CITY_SLUGS = Object.keys(cities) as Slug[];
/** The first city in shared/cities.json; the feed's default, as in the crawler. */
export const DEFAULT_CITY: string = CITY_SLUGS[0];

export const isCity = (slug: string): slug is Slug => Object.hasOwn(cities, slug);

/** A configured city's public details (the rest of its entry is the crawler's settings). */
export function cityInfo(slug: Slug): CityInfo {
  const { name, region, country, timezone, currency, lat, lon } = cities[slug];
  return { slug, name, region, country, timezone, currency, lat, lon };
}

let cache: { at: number; list: CityInfo[] } | null = null;
const CACHE_MS = 60_000;

/**
 * Every city with a feed: shared/cities.json's, then requested cities whose crawl found enough events.
 * Kept for a minute per function instance, since a requested city goes live at most every 6 hours.
 */
export async function liveCities(db: Db): Promise<CityInfo[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.list;
  let requested: CityRequestDoc[] = [];
  try {
    requested = await db.collection<CityRequestDoc>("cityRequests").find({ status: "active" }).toArray();
  } catch (err) {
    // e.g. the database user can't read cityRequests yet: the configured cities still work
    console.error("Requested cities unavailable:", err);
  }
  const list = [
    ...CITY_SLUGS.map(cityInfo),
    ...requested.filter((r) => !isCity(r._id)).map((r) => ({
      slug: r._id, name: r.name, region: r.region, country: r.country, timezone: r.timezone,
      currency: r.currency ?? "USD", lat: r.lat, lon: r.lon,
    })),
  ];
  cache = { at: Date.now(), list };
  return list;
}

/** For tests: forget the cached list. */
export function forgetLiveCities(): void {
  cache = null;
}

/** Matches a city's events. The first city's events from before cities have no `city` field. */
export const cityFilter = (slug: string) => (slug === DEFAULT_CITY ? { $in: [slug, null] } : slug);
