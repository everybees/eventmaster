import type { Config } from "@netlify/functions";
import type { NearestResponse, PlaceResult, PlacesResponse } from "../../shared/types.ts";
import { liveCities, type CityInfo } from "../lib/cities.mts";
import { getDb } from "../lib/db.mts";
import { error, handler, json } from "../lib/http.mts";
import { nearestCity, normalizeName, requestsFor, toPlaceResult, type PlaceDoc } from "../lib/places.mts";

const MAX_RESULTS = 8;
const NEAREST_MAX_M = 100_000; // farther than this from any city or town in the list: "no place found"

/**
 * GET /api/places?q=abeo         cities and towns whose name starts with what was typed, covered ones first
 * GET /api/places/nearest?lat=…&lon=…   the nearest one, and the nearest covered city ("Use my location";
 *                                        positions are rounded to 0.1°, about 10 km, here and in the app)
 */
export default handler(async (req) => {
  if (req.method !== "GET") return error(405, "Use GET");
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/$/, "");
  const db = await getDb();
  const cities = await liveCities(db);
  const places = db.collection<PlaceDoc>("places");

  if (path === "/api/places/nearest") {
    const lat = round(Number(url.searchParams.get("lat")));
    const lon = round(Number(url.searchParams.get("lon")));
    if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) return error(400, "lat and lon must be coordinates");
    const place = await places.findOne({
      location: { $near: { $geometry: { type: "Point", coordinates: [lon, lat] }, $maxDistance: NEAREST_MAX_M } },
    });
    const near = nearestCity(cities, lat, lon);
    const body: NearestResponse = {
      place: place ? toPlaceResult(place, cities, await requestsFor(db, [place])) : null,
      city: near ? { slug: near.city.slug, name: near.city.name, km: Math.round(near.km) } : null,
    };
    return json(body, { headers: { "cache-control": "no-store" } });
  }

  const q = normalizeName((url.searchParams.get("q") ?? "").slice(0, 60));
  if (q.length < 2) return json({ places: [] } satisfies PlacesResponse);
  // q is only letters, digits and spaces, so it's safe in a regex; a ^prefix match uses the `key` index
  const found = await places.find({ key: { $regex: `^${q}` } }).sort({ population: -1 }).limit(20).toArray();
  const requests = await requestsFor(db, found);
  // GeoNames' own entry first ("Winnipeg, Manitoba"); a covered city's configured name only where there's none
  const results = [...found.map((p) => toPlaceResult(p, cities, requests)), ...coveredByName(cities, q)];
  // one entry per covered city (Kitchener and Waterloo are both Kitchener-Waterloo), covered ones first
  const seen = new Set<string>();
  const places_ = results.filter((r) => !r.city || (!seen.has(r.city) && seen.add(r.city)));
  places_.sort((a, b) => Number(Boolean(b.city)) - Number(Boolean(a.city)));
  const body: PlacesResponse = { places: places_.slice(0, MAX_RESULTS) };
  return json(body, { headers: { "cache-control": "public, max-age=60", "netlify-cdn-cache-control": "public, s-maxage=300" } });
});

const round = (n: number) => Math.round(n * 10) / 10;

/** Covered cities whose own name matches, e.g. "kitch" -> Kitchener-Waterloo, which isn't a GeoNames place. */
function coveredByName(cities: CityInfo[], q: string): PlaceResult[] {
  return cities
    .filter((c) => normalizeName(c.name).startsWith(q))
    .map((c) => ({ id: 0, name: c.name, region: c.region, country: c.country, countryName: "", lat: c.lat, lon: c.lon, city: c.slug, request: null }));
}

export const config: Config = { path: ["/api/places", "/api/places/nearest"] };
