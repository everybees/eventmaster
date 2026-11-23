import type { Db } from "mongodb";

const DAY = 24 * 3600;

/** Creates every index the app relies on. Safe to run again; existing indexes are left alone. */
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
    { key: { receivedAt: 1 }, name: "expire", expireAfterSeconds: 540 * DAY }, // ~18 months
  ]);
  await db.collection("userEventState").createIndexes([{ key: { "_id.u": 1, state: 1 }, name: "by_user" }]);
  await db.collection("runs").createIndexes([{ key: { startedAt: -1 }, name: "recent" }]);
}
