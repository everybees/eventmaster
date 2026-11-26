import { MongoServerError, type Db } from "mongodb";

/**
 * Creates every index the app relies on. Safe to run again; existing indexes are left alone.
 * People's data (interactions, saved states, city requests) has no expiry: it's kept until they delete it.
 */
export async function setupIndexes(db: Db): Promise<void> {
  await db.collection("events").createIndexes([
    // every feed query is for one city (from before cities: "feed", "by_category", "by_tag"; safe to drop)
    { key: { city: 1, status: 1, visibleUntil: 1, start: 1 }, name: "city_feed" },
    { key: { city: 1, status: 1, category: 1, start: 1 }, name: "city_category" },
    { key: { city: 1, status: 1, tags: 1, start: 1 }, name: "city_tag" },
    { key: { expireAt: 1 }, name: "expire", expireAfterSeconds: 0 }, // past events delete themselves
  ]);
  await db.collection("interactions").createIndexes([
    { key: { deviceId: 1, at: -1 }, name: "by_device" },
    { key: { userId: 1, at: -1 }, name: "by_user", partialFilterExpression: { userId: { $type: "string" } } },
    { key: { eventId: 1, action: 1 }, name: "by_event" },
  ]);
  await db.collection("userEventState").createIndexes([{ key: { "_id.u": 1, state: 1 }, name: "by_user" }]);
  // the city search and "Use my location" (crawler/load_places.py fills `places`)
  await db.collection("places").createIndexes([
    { key: { key: 1 }, name: "by_name" },
    { key: { location: "2dsphere" }, name: "by_location" },
  ]);
  await db.collection("cityRequests").createIndexes([
    { key: { placeId: 1 }, name: "by_place", unique: true },
    { key: { status: 1, requests: -1 }, name: "to_crawl" },
  ]);
  await db.collection("cityRequestLog").createIndexes([
    { key: { deviceId: 1, at: -1 }, name: "by_device" },
  ]);
  await db.collection("runs").createIndexes([{ key: { startedAt: -1 }, name: "recent" }]);
  // these deleted interactions after ~18 months and the city request log after 90 days, before data was kept
  await dropIndex(db, "interactions", "expire");
  await dropIndex(db, "cityRequestLog", "expire");
}

async function dropIndex(db: Db, collection: string, name: string): Promise<void> {
  try {
    await db.collection(collection).dropIndex(name);
  } catch (err) {
    // 27: no such index (already dropped); 26: no such collection
    if (!(err instanceof MongoServerError && (err.code === 27 || err.code === 26))) throw err;
  }
}
