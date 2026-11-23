import type { Config } from "@netlify/functions";
import { getDb } from "../lib/db.mts";
import { error, EVENT_ID, FEED_CACHE, handler, json } from "../lib/http.mts";
import { toApiEvent, type EventDoc } from "../lib/models.mts";

/** GET /api/events/:id — one event, including recently removed ones (so a saved event can still show). */
export default handler(async (req, context) => {
  if (req.method !== "GET") return error(405, "Use GET");
  const id = context.params?.id ?? "";
  if (!EVENT_ID.test(id)) return error(400, "Not an event ID");
  const db = await getDb();
  const doc = await db.collection<EventDoc>("events").findOne({ _id: id });
  if (!doc) return error(404, "No such event (it may have ended)");
  return json({ ...toApiEvent(doc), status: doc.status }, { headers: FEED_CACHE });
});

export const config: Config = { path: "/api/events/:id" };
