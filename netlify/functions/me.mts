import type { Config } from "@netlify/functions";
import type { StateResponse, SwipeState } from "../../shared/types.ts";
import { getDb } from "../lib/db.mts";
import { error, handler, json, UUID } from "../lib/http.mts";
import type { InteractionDoc, StateDoc } from "../lib/models.mts";
import type { CityRequestLogDoc } from "../lib/places.mts";

/**
 * The device's own data, identified by its X-Device-Id header (a random UUID the app keeps).
 *   GET    /api/me/state  saved / passed / later per event, to restore on a reinstall or new device
 *   DELETE /api/me        "delete my data": every interaction, state and city request from this device
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
  if (req.method === "DELETE" && path === "/api/me") {
    const [interactions, removedStates, cityRequests] = await Promise.all([
      db.collection<InteractionDoc>("interactions").deleteMany({ deviceId }),
      states.deleteMany({ "_id.u": deviceId }),
      db.collection<CityRequestLogDoc>("cityRequestLog").deleteMany({ deviceId }),
    ]);
    return json({ deleted: {
      interactions: interactions.deletedCount, states: removedStates.deletedCount, cityRequests: cityRequests.deletedCount,
    } });
  }
  return error(405, "Use GET /api/me/state or DELETE /api/me");
});

export const config: Config = { path: ["/api/me", "/api/me/state"] };
