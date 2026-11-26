import type { Config } from "@netlify/functions";
import type { CityRequestResponse, CityRequestStatus } from "../../shared/types.ts";
import { liveCities } from "../lib/cities.mts";
import { getDb } from "../lib/db.mts";
import { error, handler, json, UUID } from "../lib/http.mts";
import {
  COVER_KM, nearestCity, requestSlug, type CityRequestDoc, type CityRequestLogDoc, type PlaceDoc,
} from "../lib/places.mts";

const DAY = 24 * 3600_000;
const PER_DEVICE_PER_DAY = 5;
const RETRY_UNAVAILABLE_AFTER = 30 * DAY; // a city that had too few events is tried again if asked after this
const MAX_REQUESTED_CITIES = 50;          // as crawler/load_to_mongo.py: crawled at once; the rest wait

/**
 * POST /api/city-requests  { deviceId, placeId }  "add my city"
 * The place must be one of GeoNames' cities and towns (15,000+ people): that's the validity check. A covered
 * city answers "covered". Otherwise the request is logged and the city is crawled from the next scheduled
 * run (load_to_mongo.py --list-cities), going live once it has enough events.
 */
export default handler(async (req) => {
  if (req.method !== "POST") return error(405, "Use POST");
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return error(400, "Body must be JSON");
  }
  const { deviceId, placeId } = (body ?? {}) as { deviceId?: unknown; placeId?: unknown };
  if (typeof deviceId !== "string" || !UUID.test(deviceId)) return error(400, "deviceId must be a UUID");
  if (!Number.isInteger(placeId) || (placeId as number) <= 0) return error(400, "placeId must be a place's ID");

  const db = await getDb();
  const place = await db.collection<PlaceDoc>("places").findOne({ _id: placeId as number });
  if (!place) return error(404, "That isn't a city or town we know");

  const near = nearestCity(await liveCities(db), place.lat, place.lon);
  if (near && near.km <= COVER_KM) return answer("covered", near.city.slug, near.city.name);

  const now = new Date();
  const device = deviceId.toLowerCase();
  const log = db.collection<CityRequestLogDoc>("cityRequestLog");
  if (await log.countDocuments({ deviceId: device, at: { $gte: new Date(now.getTime() - DAY) } }) >= PER_DEVICE_PER_DAY) {
    return error(429, "That's enough city requests from this device for today");
  }

  const requests = db.collection<CityRequestDoc>("cityRequests");
  const existing = await requests.findOne({ placeId: place._id });
  let slug = existing?._id ?? requestSlug(place);
  if (!existing && (await requests.findOne({ _id: slug }))) slug = `${slug}-${place._id}`; // a namesake was asked first

  const crawling = await requests.countDocuments({ status: { $in: ["pending", "active"] } });
  let status: CityRequestDoc["status"] = existing?.status ?? (crawling >= MAX_REQUESTED_CITIES ? "waitlisted" : "pending");
  if (existing?.status === "unavailable" && now.getTime() - (existing.lastCrawledAt?.getTime() ?? 0) > RETRY_UNAVAILABLE_AFTER) {
    status = "pending";
  }
  if (existing?.status === "waitlisted" && crawling < MAX_REQUESTED_CITIES) status = "pending";

  const askedBefore = await log.findOne({ deviceId: device, placeId: place._id });
  await requests.updateOne(
    { _id: slug },
    {
      $setOnInsert: {
        placeId: place._id, name: place.name, ascii: place.ascii, region: place.region, country: place.country,
        countryName: place.countryName, currency: place.currency, timezone: place.timezone, lat: place.lat,
        lon: place.lon, population: place.population, firstRequestedAt: now,
      },
      $set: { status, lastRequestedAt: now },
      $inc: { requests: askedBefore ? 0 : 1 },
    },
    { upsert: true },
  );
  await log.insertOne({ deviceId: device, placeId: place._id, slug, at: now });
  return answer(status, slug, place.name);
});

function answer(status: "covered" | "active" | CityRequestStatus, city: string, name: string): Response {
  const body: CityRequestResponse = { status, city, name };
  return json(body, { headers: { "cache-control": "no-store" } });
}

export const config: Config = { path: "/api/city-requests" };
