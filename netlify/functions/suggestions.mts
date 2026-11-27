import type { Config } from "@netlify/functions";
import type { SuggestionResponse } from "../../shared/types.ts";
import { cityFilter, liveCities } from "../lib/cities.mts";
import { getDb } from "../lib/db.mts";
import { error, handler, json, UUID } from "../lib/http.mts";
import type { EventDoc } from "../lib/models.mts";
import { cleanLink, linkKey, NOTE_MAX, SUGGESTIONS_PER_DAY, type SuggestionDoc } from "../lib/suggestions.mts";

const DAY = 24 * 3600_000;

/**
 * POST /api/suggestions  { deviceId, city, url, note? }  "Suggest an event"
 * A link to an event (an Instagram post, a ticket page, the organizer's site) for one of our cities, with an
 * optional note. It's stored for review and nothing is public until someone adds it (crawler/suggestions.py).
 * A link that's already an event in that city's feed answers "listed" with the event, and nothing is stored.
 */
export default handler(async (req) => {
  if (req.method !== "POST") return error(405, "Use POST");
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return error(400, "Body must be JSON");
  }
  const { deviceId, city, url, note } = (body ?? {}) as Record<string, unknown>;
  if (typeof deviceId !== "string" || !UUID.test(deviceId)) return error(400, "deviceId must be a UUID");
  if (typeof city !== "string") return error(400, "city must be a city's slug");
  const link = typeof url === "string" ? cleanLink(url) : null;
  if (!link) return error(400, "url must be a web page's address");
  if (note !== undefined && typeof note !== "string") return error(400, "note must be text");
  const text = (note ?? "").trim();
  if (text.length > NOTE_MAX) return error(400, `note must be ${NOTE_MAX} characters or fewer`);

  const db = await getDb();
  if (!(await liveCities(db)).some((c) => c.slug === city)) return error(400, "Unknown city; GET /api/cities lists them");

  const now = new Date();
  const listed = await db.collection<EventDoc>("events").findOne(
    { city: cityFilter(city), status: "active", visibleUntil: { $gte: now }, url: { $in: [link, `${link}/`] } },
    { projection: { _id: 1 } },
  );
  if (listed) return answer({ status: "listed", eventId: listed._id });

  const device = deviceId.toLowerCase();
  const suggestions = db.collection<SuggestionDoc>("suggestions");
  const mine = { deviceId: device, url: link };
  const before = await suggestions.findOne(mine, { projection: { _id: 1 } });
  if (!before && await suggestions.countDocuments({ deviceId: device, at: { $gte: new Date(now.getTime() - DAY) } }) >= SUGGESTIONS_PER_DAY) {
    return error(429, "That's enough suggestions from this device for today");
  }
  // the same link again from the same device: its city and note are updated, nothing else
  await suggestions.updateOne(mine, {
    $setOnInsert: { key: linkKey(link), at: now, status: "new", ...(text ? {} : { note: "" }) },
    $set: { city, updatedAt: now, ...(text ? { note: text } : {}) },
  }, { upsert: true });
  return answer({ status: "received" });
});

function answer(body: SuggestionResponse): Response {
  return json(body, { headers: { "cache-control": "no-store" } });
}

export const config: Config = { path: "/api/suggestions" };
