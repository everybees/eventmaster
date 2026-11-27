import type { Config } from "@netlify/functions";
import type { StateResponse, SwipeState } from "../../shared/types.ts";
import { getDb } from "../lib/db.mts";
import { error, handler, json, UUID } from "../lib/http.mts";
import type { EventDoc, InteractionDoc, StateDoc } from "../lib/models.mts";
import type { CityRequestLogDoc } from "../lib/places.mts";
import type { ReminderDoc } from "../lib/reminders.mts";
import type { SuggestionDoc } from "../lib/suggestions.mts";

/**
 * The device's own data, identified by its X-Device-Id header (a random UUID the app keeps).
 *   GET    /api/me/state   saved / passed / later per event, to restore on a reinstall or new device
 *   GET    /api/me/export  "download my data": everything stored for this device, as a JSON file
 *   DELETE /api/me         "delete my data": every interaction, state, city request, suggestion and reminder from this device
 * Anyone holding a device ID can read or delete its data, which is why IDs are random UUIDs
 * and never shown. Accounts will replace this with real sign-in.
 */
export default handler(async (req) => {
  const deviceId = (req.headers.get("x-device-id") ?? "").toLowerCase();
  if (!UUID.test(deviceId)) return error(400, "Send the device's UUID in an X-Device-Id header");
  const { pathname } = new URL(req.url);
  const path = pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  const db = await getDb();
  const states = db.collection<StateDoc>("userEventState");

  if (req.method === "GET" && path === "/api/me/state") {
    const docs = await states.find({ "_id.u": deviceId, state: { $ne: null } }).toArray();
    const body: StateResponse = {
      deviceId,
      states: docs.map((d) => ({ eventId: d._id.e, state: d.state as SwipeState, updatedAt: d.updatedAt.toISOString() })),
    };
    return json(body, { headers: { "cache-control": "no-store" } });
  }
  if (req.method === "GET" && path === "/api/me/export") {
    const [interactions, stateDocs, requests, suggestions, reminders] = await Promise.all([
      db.collection<InteractionDoc>("interactions").find({ deviceId }).sort({ at: 1 }).toArray(),
      states.find({ "_id.u": deviceId }).toArray(),
      db.collection<CityRequestLogDoc>("cityRequestLog").find({ deviceId }).sort({ at: 1 }).toArray(),
      db.collection<SuggestionDoc>("suggestions").find({ deviceId }).sort({ at: 1 }).toArray(),
      db.collection<ReminderDoc>("reminders").findOne({ _id: deviceId }),
    ]);
    // event IDs mean little to a person: add the title of each event that's still listed
    const ids = [...new Set([...interactions.map((i) => i.eventId), ...stateDocs.map((d) => d._id.e)])];
    const events = await db.collection<EventDoc>("events").find({ _id: { $in: ids } }, { projection: { title: 1 } }).toArray();
    const title = new Map(events.map((e) => [e._id, e.title]));
    const body = {
      deviceId,
      exportedAt: new Date().toISOString(),
      interactions: interactions.map((i) => ({
        id: i._id, eventId: i.eventId, event: title.get(i.eventId) ?? null, action: i.action, category: i.category,
        context: i.context, at: i.at, receivedAt: i.receivedAt,
      })),
      states: stateDocs.map((d) => ({ eventId: d._id.e, event: title.get(d._id.e) ?? null, state: d.state, updatedAt: d.updatedAt })),
      cityRequests: requests.map((r) => ({ placeId: r.placeId, city: r.slug, at: r.at })),
      suggestions: suggestions.map((x) => ({
        city: x.city, url: x.url, note: x.note, at: x.at, updatedAt: x.updatedAt, status: x.status,
        ...(x.eventId ? { eventId: x.eventId } : {}),
      })),
      // the push service address reminders go to, and the events they're for
      reminders: reminders && {
        pushService: new URL(reminders.subscription.endpoint).hostname, events: reminders.events,
        sent: reminders.sent, since: reminders.createdAt,
      },
    };
    return json(body, { headers: { "cache-control": "no-store" } });
  }
  if (req.method === "DELETE" && path === "/api/me") {
    const [interactions, removedStates, cityRequests, suggestions, reminders] = await Promise.all([
      db.collection<InteractionDoc>("interactions").deleteMany({ deviceId }),
      states.deleteMany({ "_id.u": deviceId }),
      db.collection<CityRequestLogDoc>("cityRequestLog").deleteMany({ deviceId }),
      // an event added from a suggestion stays: it's the organizer's public listing, not this person's data
      db.collection<SuggestionDoc>("suggestions").deleteMany({ deviceId }),
      db.collection<ReminderDoc>("reminders").deleteOne({ _id: deviceId }),
    ]);
    return json({ deleted: {
      interactions: interactions.deletedCount, states: removedStates.deletedCount, cityRequests: cityRequests.deletedCount,
      suggestions: suggestions.deletedCount, reminders: reminders.deletedCount,
    } });
  }
  return error(405, "Use GET /api/me/state, GET /api/me/export or DELETE /api/me");
});

export const config: Config = { path: ["/api/me", "/api/me/state", "/api/me/export"] };
