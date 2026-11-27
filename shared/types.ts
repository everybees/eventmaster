// Shapes shared by the API (netlify/functions) and the app (web/).
// ApiEvent mirrors shared/event.schema.json; tests/api.test.mts checks API responses against it.

export const SWIPE_STATES = ["saved", "passed", "later"] as const;
export type SwipeState = (typeof SWIPE_STATES)[number];

export const ACTIONS = [
  "view", "details", "save", "pass", "later", "unsave", "undo", "open_link", "tickets", "map", "share", "calendar",
  "going",     // "I'm going"
  "not_going", // took "I'm going" back
  "attended",  // the answer to "Did you go?" (context.answer)
  "rated",     // thumbs up or down after going (context.rating)
] as const;
export type Action = (typeof ACTIONS)[number];

export const VIAS = ["swipe", "button", "tap", "list", "reminder"] as const; // reminder: opened from a notification
export type Via = (typeof VIAS)[number];

export const ANSWERS = ["yes", "no", "cancelled"] as const; // "Did you go?": Yes / No / It didn't happen
export type Answer = (typeof ANSWERS)[number];
export const RATINGS = ["up", "down"] as const;
export type Rating = (typeof RATINGS)[number];

export interface Showtime {
  cinema: string;
  address: string;
  date: string;      // "2026-11-23"
  times: string[];   // "18:40", 24-hour, the city's time
  tickets: string[]; // for each time, in the same order: a link to buy that showing, or ""
  url?: string;      // when the cinema's times aren't listed here (Filmhouse): its page for them; times is then []
}

/** A city the app covers (shared/cities.json), with how many events it has now. */
export interface City {
  slug: string;      // "winnipeg"
  name: string;      // "Winnipeg"
  region: string;    // "MB"
  country: string;   // "CA"
  timezone: string;  // "America/Winnipeg"
  currency: string;  // "CAD": for prices whose listing doesn't say
  lat: number;
  lon: number;
  count: number;     // events in its feed now
}

export interface CitiesResponse {
  defaultCity: string;
  cities: City[];
}

/** Where a request for a city we don't cover stands: waiting for its first crawl, crawled with too few
 *  events to show, or waiting its turn (only so many requested cities are crawled at once). */
export type CityRequestStatus = "pending" | "unavailable" | "waitlisted";

/** A city or town from the search or "Use my location" (GeoNames' places with 15,000+ people). */
export interface PlaceResult {
  id: number;                        // GeoNames ID; 0 for a covered city found by its own name
  name: string;
  region: string;                    // "Ogun State"
  country: string;                   // "NG"
  countryName: string;               // "Nigeria"
  lat: number;
  lon: number;
  city: string | null;               // the covered city it's in or beside (within 20 km)
  request: CityRequestStatus | null; // not covered, and someone asked for it
}

export interface PlacesResponse {
  places: PlaceResult[];
}

export interface NearestResponse {
  place: PlaceResult | null;                                  // the nearest city or town
  city: { slug: string; name: string; km: number } | null;   // the nearest covered city
}

export interface CityRequestResponse {
  status: "covered" | "active" | CityRequestStatus;
  city: string; // slug: the covered city, or the requested one's future slug
  name: string;
}

/** "Suggest an event": a link to an event for one of our cities, reviewed by a person before it's listed. */
export interface SuggestionRequest {
  deviceId: string;
  city: string;      // a City slug
  url: string;       // the event's page: an Instagram post, a ticket page, the organizer's site
  note?: string;     // anything the link doesn't say (500 characters at most)
}

export interface SuggestionResponse {
  status: "received" | "listed"; // listed: it's already an event in that city's feed (eventId), and nothing was stored
  eventId?: string;
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
  price: { text: string; free: boolean | null; currency: string | null }; // currency: "CAD", "USD"…, when listed
  cost: "Free" | "Paid" | "Unknown";
  image: string | null;       // the source's image URL
  description: string;
  url: string;                // the original listing (for sharing and calendars)
  tickets: Tickets | null;
  source: string;
  showtimes: Showtime[];      // films: the week, per cinema
  popularity: Popularity | null; // null until enough people have shown interest
}

/** Counted across people who share their activity, and only shown once enough have (lib/stats.mts). */
export interface Popularity {
  interested: number;     // saved it, are going, or tapped tickets, calendar or share
  going: number | null;   // null when too few to show
  popular: boolean;       // among the city's most popular right now
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
  answer?: Answer;                      // for "attended"
  rating?: Rating;                      // for "rated"
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

/** A browser's push subscription (PushSubscription.toJSON()). */
export interface PushSubscriptionJson {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** PUT /api/reminders: turn reminders on, or update which events they're for. */
export interface RemindersRequest {
  deviceId: string;
  subscription: PushSubscriptionJson;
  events: string[]; // the saved events still ahead
}

/** POST /api/tally: anonymous counts, no device ID. */
export const TALLIES = ["consent_yes", "consent_no", "installed"] as const;
export type Tally = (typeof TALLIES)[number];

export interface StateResponse {
  deviceId: string;
  states: { eventId: string; state: SwipeState; updatedAt: string }[];
}
