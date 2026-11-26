import type { Db } from "mongodb";
import type { City, CityRequestStatus, PlaceResult } from "../../shared/types.ts";

/** A city or town, from GeoNames (crawler/load_places.py). */
export interface PlaceDoc {
  _id: number;
  name: string;
  ascii: string;
  key: string;            // normalizeName(ascii), for prefix search
  region: string;
  country: string;
  countryName: string;
  currency: string | null;
  timezone: string;
  population: number;
  lat: number;
  lon: number;
  location: { type: "Point"; coordinates: [number, number] };
}

/** A city someone asked for, keyed by its slug. The crawler crawls it and sets `status` (load_to_mongo.py). */
export interface CityRequestDoc {
  _id: string;
  placeId: number;
  name: string;
  ascii: string;
  region: string;
  country: string;
  countryName: string;
  currency: string | null;
  timezone: string;
  lat: number;
  lon: number;
  population: number;
  status: "active" | CityRequestStatus;
  requests: number;       // distinct devices that asked
  firstRequestedAt: Date;
  lastRequestedAt: Date;
  lastCrawledAt?: Date;
  eventCount?: number;
}

/** One device asking for one place: for the per-device daily limit, and deleted with "Delete my data". */
export interface CityRequestLogDoc {
  deviceId: string;
  placeId: number;
  slug: string;
  at: Date;
}

/** A place this close to a covered city's centre counts as that city (Waterloo is Kitchener-Waterloo's). */
export const COVER_KM = 20;

/** "St. John's" -> "st johns", "Montréal" -> "montreal": as crawler/events.py's norm(). */
export function normalizeName(s: string): string {
  return s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/['’`]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

/** "abeokuta-ng": a requested city's slug (the API adds the place's ID if two places would share one). */
export const requestSlug = (p: Pick<PlaceDoc, "ascii" | "country">) =>
  `${normalizeName(p.ascii).replaceAll(" ", "-")}-${p.country.toLowerCase()}`;

/** Great-circle distance in km. */
export function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * rad) / 2) ** 2
    + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}

type CityInfo = Omit<City, "count">;

export function nearestCity(cities: CityInfo[], lat: number, lon: number): { city: CityInfo; km: number } | null {
  let best: { city: CityInfo; km: number } | null = null;
  for (const city of cities) {
    const km = distanceKm(lat, lon, city.lat, city.lon);
    if (!best || km < best.km) best = { city, km };
  }
  return best;
}

/** The requests for these places, by place ID. */
export async function requestsFor(db: Db, places: PlaceDoc[]): Promise<Map<number, CityRequestDoc>> {
  if (!places.length) return new Map();
  const docs = await db.collection<CityRequestDoc>("cityRequests").find({ placeId: { $in: places.map((p) => p._id) } }).toArray();
  return new Map(docs.map((d) => [d.placeId, d]));
}

export function toPlaceResult(p: PlaceDoc, cities: CityInfo[], requests: Map<number, CityRequestDoc>): PlaceResult {
  const near = nearestCity(cities, p.lat, p.lon);
  const city = near && near.km <= COVER_KM ? near.city.slug : null;
  const request = requests.get(p._id);
  return {
    id: p._id, name: p.name, region: p.region, country: p.country, countryName: p.countryName, lat: p.lat, lon: p.lon,
    city,
    request: !city && request && request.status !== "active" ? request.status : null,
  };
}
