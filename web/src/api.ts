import type {
  ApiEvent, CitiesResponse, CityRequestResponse, EventsResponse, NearestResponse, PlaceResult, PlacesResponse,
} from "../../shared/types.ts";
import { deviceId } from "./device.ts";

export async function fetchEvents(city: string): Promise<ApiEvent[]> {
  const res = await fetch(`/api/events?city=${encodeURIComponent(city)}`);
  if (!res.ok) throw new Error(`The events didn't load (error ${res.status}).`);
  return ((await res.json()) as EventsResponse).events;
}

export async function fetchCities(): Promise<CitiesResponse> {
  const res = await fetch("/api/cities");
  if (!res.ok) throw new Error(`The list of cities didn't load (error ${res.status}).`);
  return (await res.json()) as CitiesResponse;
}

/** Cities and towns whose name starts with `q`, covered ones first. */
export async function searchPlaces(q: string, signal?: AbortSignal): Promise<PlaceResult[]> {
  const res = await fetch(`/api/places?q=${encodeURIComponent(q)}`, { signal });
  if (!res.ok) throw new Error(`The search didn’t work (error ${res.status}).`);
  return ((await res.json()) as PlacesResponse).places;
}

/** The place nearest a position, rounded here to 0.1° (about 10 km): enough to find the city, not the street. */
export async function nearestPlace(lat: number, lon: number): Promise<NearestResponse> {
  const round = (n: number) => (Math.round(n * 10) / 10).toFixed(1);
  const res = await fetch(`/api/places/nearest?lat=${round(lat)}&lon=${round(lon)}`);
  if (!res.ok) throw new Error(`Your city couldn’t be found (error ${res.status}). Search for it instead.`);
  return (await res.json()) as NearestResponse;
}

/** "Add my city". */
export async function requestCity(placeId: number): Promise<CityRequestResponse> {
  const res = await fetch("/api/city-requests", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceId: deviceId(), placeId }),
  });
  if (res.status === 429) throw new Error("That’s enough city requests from this phone for today. Try again tomorrow.");
  if (!res.ok) throw new Error(`The request didn’t go through (error ${res.status}).`);
  return (await res.json()) as CityRequestResponse;
}

/** "Download my data": everything the server holds for this device, saved as a JSON file. */
export async function downloadMyData(): Promise<void> {
  const res = await fetch("/api/me/export", { headers: { "x-device-id": deviceId() } });
  if (!res.ok) throw new Error(`Your data couldn't be downloaded (error ${res.status}).`);
  const url = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement("a"), { href: url, download: `my-event-data-${new Date().toISOString().slice(0, 10)}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export async function deleteMyData(): Promise<void> {
  const res = await fetch("/api/me", { method: "DELETE", headers: { "x-device-id": deviceId() } });
  if (!res.ok) throw new Error(`Your data couldn't be deleted (error ${res.status}).`);
}

/** A resized, cached copy from Netlify Image CDN (the source hosts are allowlisted in netlify.toml). */
export const imageUrl = (src: string, width: number) => `/.netlify/images?url=${encodeURIComponent(src)}&w=${width}&q=70`;
