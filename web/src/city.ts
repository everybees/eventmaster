import type { City } from "../../shared/types.ts";

const CITY_KEY = "wpg.city";
const LIST_KEY = "wpg.cities"; // the last list from the server, for names while offline
const REQUESTED_KEY = "wpg.requested"; // cities this person asked for, to say when they're ready

/** The city this person picked, or null on their first visit. */
export const savedCity = (): string | null => localStorage.getItem(CITY_KEY);
export const saveCity = (slug: string) => localStorage.setItem(CITY_KEY, slug);

function readList(): { cities: City[]; defaultCity: string } | null {
  try {
    return JSON.parse(localStorage.getItem(LIST_KEY) ?? "null");
  } catch {
    return null;
  }
}

let known = readList();
export const cachedCities = (): City[] | null => known?.cities ?? null;

export function rememberCities(cities: City[], defaultCity: string): void {
  known = { cities, defaultCity };
  localStorage.setItem(LIST_KEY, JSON.stringify(known));
}

export interface Requested {
  slug: string;
  name: string;
}

export function requestedCities(): Requested[] {
  try {
    return JSON.parse(localStorage.getItem(REQUESTED_KEY) ?? "[]");
  } catch {
    return [];
  }
}

export function rememberRequest(r: Requested): void {
  const list = requestedCities().filter((x) => x.slug !== r.slug);
  localStorage.setItem(REQUESTED_KEY, JSON.stringify([...list, r]));
}

export function forgetRequest(slug: string): void {
  localStorage.setItem(REQUESTED_KEY, JSON.stringify(requestedCities().filter((x) => x.slug !== slug)));
}

/** "Winnipeg". Events saved before cities have no city; they're the first city's. */
export function cityName(slug: string | undefined): string {
  const s = slug ?? known?.defaultCity;
  return known?.cities.find((c) => c.slug === s)?.name ?? (s ? s[0].toUpperCase() + s.slice(1) : "");
}

/** The currency of a city's prices, for listings that don't name theirs. */
export const cityCurrency = (slug: string | undefined): string | null =>
  known?.cities.find((c) => c.slug === (slug ?? known?.defaultCity))?.currency ?? null;

/** Great-circle distance in km. */
export function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * rad) / 2) ** 2
    + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}

export function nearestCity(cities: City[], lat: number, lon: number): { city: City; km: number } | null {
  let best: { city: City; km: number } | null = null;
  for (const city of cities) {
    const km = distanceKm(lat, lon, city.lat, city.lon);
    if (!best || km < best.km) best = { city, km };
  }
  return best;
}
