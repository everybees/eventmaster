import cities from "../../shared/cities.json" with { type: "json" };
import type { City } from "../../shared/types.ts";

type Slug = keyof typeof cities;

export const CITY_SLUGS = Object.keys(cities) as Slug[];
/** The first city in shared/cities.json; the feed's default, as in the crawler. */
export const DEFAULT_CITY: string = CITY_SLUGS[0];

export const isCity = (slug: string): slug is Slug => Object.hasOwn(cities, slug);

/** A city's public details (the rest of its entry is the crawler's settings). */
export function cityInfo(slug: Slug): Omit<City, "count"> {
  const { name, region, country, timezone, currency, lat, lon } = cities[slug];
  return { slug, name, region, country, timezone, currency, lat, lon };
}

/** Matches a city's events. The first city's events from before cities have no `city` field. */
export const cityFilter = (slug: string) => (slug === DEFAULT_CITY ? { $in: [slug, null] } : slug);
