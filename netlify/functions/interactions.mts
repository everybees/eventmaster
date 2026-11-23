import type { Config } from "@netlify/functions";
import { MongoBulkWriteError, type AnyBulkWriteOperation, type Collection, type Db } from "mongodb";
import { getDb } from "../lib/db.mts";
import { error, handler, json } from "../lib/http.mts";
import type { EventDoc, InteractionDoc, StateDoc } from "../lib/models.mts";
import { nextState, parseBatch, type Item } from "../lib/validate.mts";

const MAX_BODY = 64_000;

/**
 * POST /api/interactions — a batch of swipes, taps and clicks from one device.
 * Body: { deviceId, items: [{ id, eventId, action, at, context }] } (see shared/types.ts).
 * Safe to retry: each item's id is its primary key, so a resent item is ignored.
 */
export default handler(async (req) => {
  if (req.method !== "POST") return error(405, "Use POST");
  const text = await req.text();
  if (text.length > MAX_BODY) return error(413, "Batch too large");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return error(400, "Body must be JSON");
  }
  const batch = parseBatch(body);
  if ("error" in batch) return error(400, batch.error);

  const db = await getDb();
  // only interactions with events we know about (also keeps junk out)
  const ids = [...new Set(batch.items.map((i) => i.eventId))];
  const events = await db.collection<EventDoc>("events")
    .find({ _id: { $in: ids } }, { projection: { category: 1 } })
    .toArray();
  const category = new Map(events.map((e) => [e._id, e.category]));
  const items = batch.items.filter((i) => category.has(i.eventId));

  if (items.length) {
    const receivedAt = new Date();
    await insertNew(db.collection<InteractionDoc>("interactions"), items.map((i) => ({
      _id: i.id,
      deviceId: batch.deviceId,
      userId: null,
      eventId: i.eventId,
      action: i.action,
      category: category.get(i.eventId)!,
      context: i.context,
      at: i.at,
      receivedAt,
    })));
    await applyStates(db, batch.deviceId, items);
  }
  return json({ accepted: items.length, rejected: batch.rejected + batch.items.length - items.length }, { status: 202 });
});

/** Inserts what's new and ignores items already stored (a retried batch). */
async function insertNew(col: Collection<InteractionDoc>, docs: InteractionDoc[]): Promise<void> {
  try {
    await col.insertMany(docs, { ordered: false });
  } catch (err) {
    if (!onlyDuplicates(err)) throw err;
  }
}

/**
 * Updates each event's current state from the batch's latest state-changing item. An update only
 * lands if it's newer than what's stored, so a batch that arrives late can't undo a newer swipe:
 * when the stored state is newer, the filter misses, the upsert tries to insert the same _id, and
 * that duplicate-key error is the expected "skip".
 */
async function applyStates(db: Db, deviceId: string, items: Item[]): Promise<void> {
  const latest = new Map<string, Item>();
  for (const item of items) {
    if (nextState(item) === undefined) continue;
    const prev = latest.get(item.eventId);
    if (!prev || item.at >= prev.at) latest.set(item.eventId, item);
  }
  const ops: AnyBulkWriteOperation<StateDoc>[] = [...latest.values()].map((item) => ({
    updateOne: {
      filter: { _id: { u: deviceId, e: item.eventId }, updatedAt: { $lte: item.at } },
      update: { $set: { state: nextState(item) ?? null, updatedAt: item.at } },
      upsert: true,
    },
  }));
  if (!ops.length) return;
  try {
    await db.collection<StateDoc>("userEventState").bulkWrite(ops, { ordered: false });
  } catch (err) {
    if (!onlyDuplicates(err)) throw err;
  }
}

function onlyDuplicates(err: unknown): boolean {
  if (!(err instanceof MongoBulkWriteError)) return false;
  const errors = Array.isArray(err.writeErrors) ? err.writeErrors : [err.writeErrors];
  return errors.length > 0 && errors.every((e) => e.code === 11000);
}

export const config: Config = { path: "/api/interactions" };
