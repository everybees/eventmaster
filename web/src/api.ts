import type { ApiEvent, CitiesResponse, EventsResponse } from "../../shared/types.ts";
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

export async function deleteMyData(): Promise<void> {
  const res = await fetch("/api/me", { method: "DELETE", headers: { "x-device-id": deviceId() } });
  if (!res.ok) throw new Error(`Your data couldn't be deleted (error ${res.status}).`);
}

/** A resized, cached copy from Netlify Image CDN (the source hosts are allowlisted in netlify.toml). */
export const imageUrl = (src: string, width: number) => `/.netlify/images?url=${encodeURIComponent(src)}&w=${width}&q=70`;
