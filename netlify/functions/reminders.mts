import type { Config } from "@netlify/functions";
import { getDb } from "../lib/db.mts";
import { error, EVENT_ID, handler, json, UUID } from "../lib/http.mts";
import { parseSubscription, publicKey, type ReminderDoc } from "../lib/reminders.mts";

const MAX_EVENTS = 300;

/**
 * Event reminders (Web Push), only for devices that turn them on.
 *   GET    /api/reminders/key  the public key the browser subscribes with; 404 while reminders aren't set up
 *   PUT    /api/reminders      { deviceId, subscription, events }: on, or which events (the saved ones ahead)
 *   DELETE /api/reminders      off (X-Device-Id header); "Delete my data" does this too
 * The reminders themselves go out from send-reminders.mts.
 */
export default handler(async (req) => {
  const path = new URL(req.url).pathname.replace(/\/$/, "");
  const key = publicKey();
  if (req.method === "GET" && path === "/api/reminders/key") {
    if (!key) return error(404, "Reminders aren't set up");
    return json({ publicKey: key }, { headers: { "cache-control": "public, max-age=3600" } });
  }
  if (path !== "/api/reminders") return error(404, "Not found");

  if (req.method === "PUT") {
    if (!key) return error(404, "Reminders aren't set up");
    let body: Record<string, unknown>;
    try {
      body = JSON.parse((await req.text()).slice(0, 40_000));
    } catch {
      return error(400, "Body must be JSON");
    }
    const deviceId = typeof body?.deviceId === "string" ? body.deviceId.toLowerCase() : "";
    if (!UUID.test(deviceId)) return error(400, "deviceId must be a UUID");
    const subscription = parseSubscription(body.subscription);
    if (!subscription) return error(400, "subscription must be a push subscription from a browser's push service");
    const events = Array.isArray(body.events) ? [...new Set(body.events)] : null;
    if (!events || events.length > MAX_EVENTS || !events.every((e) => typeof e === "string" && EVENT_ID.test(e))) {
      return error(400, `events must be up to ${MAX_EVENTS} event IDs`);
    }
    const now = new Date();
    // one document per device; reminders already sent for events still listed stay marked as sent
    await (await getDb()).collection<ReminderDoc>("reminders").updateOne({ _id: deviceId }, [{
      $set: {
        subscription, events, updatedAt: now, createdAt: { $ifNull: ["$createdAt", now] },
        sent: { $filter: { input: { $ifNull: ["$sent", []] }, cond: { $in: [{ $arrayElemAt: [{ $split: ["$$this", ":"] }, 0] }, events] } } },
      },
    }], { upsert: true });
    return json({ events: events.length }, { headers: { "cache-control": "no-store" } });
  }

  if (req.method === "DELETE") {
    const deviceId = (req.headers.get("x-device-id") ?? "").toLowerCase();
    if (!UUID.test(deviceId)) return error(400, "Send the device's UUID in an X-Device-Id header");
    const { deletedCount } = await (await getDb()).collection<ReminderDoc>("reminders").deleteOne({ _id: deviceId });
    return json({ deleted: deletedCount }, { headers: { "cache-control": "no-store" } });
  }
  return error(405, "Use GET /api/reminders/key, PUT or DELETE /api/reminders");
});

export const config: Config = { path: ["/api/reminders", "/api/reminders/key"] };
