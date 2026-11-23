import type { Action, ApiEvent, InteractionContext, Showtime, SwipeState } from "../../shared/types.ts";
import { DEFAULT_CITY } from "./cities.mts";
import { ticketsFor } from "./tickets.mts";

/** An `events` document, as crawler/load_to_mongo.py writes it. */
export interface EventDoc {
  _id: string;
  city?: string | null;     // absent on the first city's events from before cities
  title: string;
  category: string;
  tags: string[];
  start: Date;
  end: Date | null;
  startLocal: string;
  endLocal: string | null;
  allDay: boolean;
  times: string[];
  venue: { name: string; address: string };
  price: { text: string; free: boolean | null };
  cost: "Free" | "Paid" | "Unknown";
  image: string | null;
  description: string;
  url: string;
  ticketUrl?: string | null;      // where the listing says to buy (AllEvents pages name the seller)
  ticketCheckedAt?: Date | null;
  source: string;
  showtimes: (Omit<Showtime, "tickets"> & { tickets?: string[] })[]; // older crawls have no ticket links
  status: "active" | "removed";
  visibleUntil: Date;
  expireAt: Date;
  firstSeen?: Date;
  lastSeen?: Date;
  missedRuns?: number;
}

/** One swipe, tap or click; `interactions` is an append-only log. */
export interface InteractionDoc {
  _id: string;              // the device's UUID for it, so a resend is a duplicate key, not a second row
  deviceId: string;
  userId: string | null;    // set when accounts arrive and a device is linked
  eventId: string;
  action: Action;
  category: string;         // copied from the event, so stats outlive the event document
  context: InteractionContext;
  at: Date;                 // device time
  receivedAt: Date;
}

/** Where one user currently stands on one event; drives the Saved list and sync. */
export interface StateDoc {
  _id: { u: string; e: string };  // always built in this key order: MongoDB compares embedded documents in order
  state: SwipeState | null;
  updatedAt: Date;
}

export function toApiEvent(d: EventDoc): ApiEvent {
  return {
    id: d._id,
    city: d.city ?? DEFAULT_CITY,
    title: d.title,
    category: d.category,
    tags: d.tags ?? [],
    start: d.start.toISOString(),
    end: d.end ? d.end.toISOString() : null,
    startLocal: d.startLocal,
    endLocal: d.endLocal ?? null,
    allDay: Boolean(d.allDay),
    times: d.times ?? [],
    venue: { name: d.venue?.name ?? "", address: d.venue?.address ?? "" },
    price: { text: d.price?.text ?? "", free: d.price?.free ?? null },
    cost: d.cost ?? "Unknown",
    image: d.image ?? null,
    description: d.description ?? "",
    url: d.url,
    tickets: d.ticketUrl ? ticketsFor(d.ticketUrl, true) : ticketsFor(d.url),
    source: d.source,
    showtimes: (d.showtimes ?? []).map((s) => ({
      ...s,
      tickets: s.tickets?.length === s.times.length ? s.tickets : s.times.map(() => ""),
    })),
  };
}
