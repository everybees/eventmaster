// Shapes shared by the API (netlify/functions) and the app (web/).
// ApiEvent mirrors shared/event.schema.json; tests/api.test.mts checks API responses against it.

export const SWIPE_STATES = ["saved", "passed", "later"] as const;
export type SwipeState = (typeof SWIPE_STATES)[number];

export const ACTIONS = [
  "view", "details", "save", "pass", "later", "unsave", "undo", "open_link", "tickets", "share", "calendar",
] as const;
export type Action = (typeof ACTIONS)[number];

export const VIAS = ["swipe", "button", "tap", "list"] as const;
export type Via = (typeof VIAS)[number];

export interface Showtime {
  cinema: string;
  address: string;
  date: string;      // "2026-11-23"
  times: string[];   // "18:40", 24-hour, the city's time
  tickets: string[]; // for each time, in the same order: a link to buy that showing, or ""
}

/** A city the app covers (shared/cities.json), with how many events it has now. */
export interface City {
  slug: string;      // "winnipeg"
  name: string;      // "Winnipeg"
  region: string;    // "MB"
  country: string;   // "CA"
  timezone: string;  // "America/Winnipeg"
  lat: number;
  lon: number;
  count: number;     // events in its feed now
}

export interface CitiesResponse {
  defaultCity: string;
  cities: City[];
}

/** Where to buy: the event's page when it sells tickets (Eventbrite, Ticketmaster), or the seller a listing
 *  names (AllEvents does); null when neither. Films are bought per showing (Showtime.tickets). */
export interface Tickets {
  url: string;          // the event page, or an affiliate link to it
  seller: string;       // "Ticketmaster"
  affiliate: boolean;   // true: we may earn a commission on a sale, and the app says so
}

export interface ApiEvent {
  id: string;                 // "evt_" + 16 hex characters, stable across crawls
  city: string;               // a City slug
  title: string;
  category: string;
  tags: string[];             // holiday, family, ongoing
  start: string;              // ISO instant (UTC), for sorting
  end: string | null;
  startLocal: string;         // the city's wall-clock time as listed: "2026-11-23" or "2026-11-23T19:00"
  endLocal: string | null;
  allDay: boolean;            // listed with a date but no time
  times: string[];            // every listed start time that day, "19:00"
  venue: { name: string; address: string };
  price: { text: string; free: boolean | null };
  cost: "Free" | "Paid" | "Unknown";
  image: string | null;       // the source's image URL
  description: string;
  url: string;                // the original listing (for sharing and calendars)
  tickets: Tickets | null;
  source: string;
  showtimes: Showtime[];      // films: the week, per cinema
}

export interface EventsResponse {
  city: string;
  generatedAt: string;
  count: number;
  events: ApiEvent[];
}

export interface InteractionContext {
  via?: Via;
  position?: number;                    // place in the stack (0 = top card)
  filter?: string;                      // the category chip in use
  restoredState?: SwipeState | null;    // for "undo": the state the event went back to
}

export interface InteractionItem {
  id: string;        // a UUID made on the device, so a retried upload can't be counted twice
  eventId: string;
  action: Action;
  at: string;        // ISO time on the device
  context?: InteractionContext;
}

export interface InteractionBatch {
  deviceId: string;
  items: InteractionItem[];
}

export interface StateResponse {
  deviceId: string;
  states: { eventId: string; state: SwipeState; updatedAt: string }[];
}
