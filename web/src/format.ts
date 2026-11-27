import type { ApiEvent, Showtime } from "../../shared/types.ts";
import { cityCurrency, cityName } from "./city.ts";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const TAG_LABELS: Record<string, string> = { holiday: "Holiday", family: "Family", ongoing: "On now" };
const pad = (n: number) => String(n).padStart(2, "0");

/** "2026-11-23" or "2026-11-23T19:00" (the city's wall-clock time, as listed) → a Date in the device's zone, for display only. */
export function parseLocal(s: string): Date {
  const [date, time = "00:00"] = s.split("T");
  const [y, m, d] = date.split("-").map(Number);
  const [h, min] = time.split(":").map(Number);
  return new Date(y, m - 1, d, h, min);
}

export function dateParts(s: string) {
  const d = parseLocal(s);
  return {
    wd: WEEKDAYS[d.getDay()],
    day: String(d.getDate()),
    mon: MONTHS[d.getMonth()],
    long: `${WEEKDAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}`,
  };
}

export function todayLocal(): string {
  const n = new Date();
  return `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}`;
}

/** "19:00" → "7:00 PM" */
export function time12(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  return `${h % 12 || 12}:${pad(m)} ${h < 12 ? "AM" : "PM"}`;
}

export const shortSource = (source: string) => source.replace(/\s*\(.*\)$/, "");

/**
 * "25" → "$25", "5000" in NGN → "₦5,000", "22.64" → "$22.64". The city's own currency gets its short symbol
 * ($ in Canada, ₦ in Nigeria); any other gets an unambiguous one (US$, £), so a Lagos show priced in dollars
 * doesn't read as naira or Canadian dollars.
 */
function money(amount: string, currency: string | null, local: boolean): string {
  const n = Number(amount);
  if (!Number.isFinite(n)) return amount;
  if (!currency) return `$${amount}`; // no currency known: as before
  const cents = n % 1 !== 0;
  try {
    return new Intl.NumberFormat("en-CA", {
      style: "currency", currency, currencyDisplay: local ? "narrowSymbol" : "symbol",
      minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0,
    }).format(n);
  } catch {
    return `${currency} ${amount}`;
  }
}

export function priceText(e: ApiEvent): string {
  if (e.cost === "Free") return "Free";
  const t = e.price.text;
  if (!t || t.startsWith("Paid")) return "Price on listing";
  if (!/^\d/.test(t)) return t;
  // the listing's own currency (a Lagos show may be priced in USD), else the city's
  const local = cityCurrency(e.city);
  const currency = e.price.currency ?? local;
  return t.split("–").map((part) => money(part.trim(), currency, currency === local)).join("–");
}

export function priceNote(e: ApiEvent): string {
  const source = shortSource(e.source);
  return e.price.text || e.cost === "Free" ? `From the ${source} listing` : `Not in the ${source} listing`;
}

export const placeText = (e: ApiEvent) => [e.venue.name, e.venue.address].filter(Boolean).join(", ") || cityName(e.city);

/** Venues that aren't places: nothing to show on a map. */
const NO_PLACE_RE = /^(online|virtual|zoom|tba|tbd|to be announced|location tba)\b/i;

/**
 * A Google Maps search for a place (it opens the Maps app where there is one). Plain links need no API key,
 * and Google learns nothing unless the person taps one. The city is added unless the address already has it.
 */
export function mapsUrl(place: string, city: string): string {
  const query = !city || place.toLowerCase().includes(city.toLowerCase()) ? place : `${place}, ${city}`;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

/** A cinema whose times stay on its own site (Filmhouse): no times, a link to them. */
export const timesElsewhere = (s: Showtime) => !s.times.length && Boolean(s.url);

/** The map link for an event's venue, or null: no venue, online, or a film at several cinemas (each cinema gets
 *  its own) or at a chain's cinemas. */
export function venueMapUrl(e: ApiEvent): string | null {
  const { name, address } = e.venue;
  if ((!name && !address) || NO_PLACE_RE.test(name.trim())) return null;
  if (new Set(e.showtimes.map((s) => s.cinema)).size > 1 || e.showtimes.some(timesElsewhere)) return null;
  return mapsUrl([name, address].filter(Boolean).join(", "), cityName(e.city));
}

/** The tags' labels. "On now" only once it has begun: a film's opening week or an exhibition can be listed ahead. */
export const tagText = (e: ApiEvent) => e.tags
  .filter((t) => t !== "ongoing" || e.startLocal.slice(0, 10) <= todayLocal())
  .map((t) => TAG_LABELS[t] ?? t).join(" · ");

/** Each cinema's next day with showings, then the links of those whose times are on their own site (films only). */
export function nextShowtimes(e: ApiEvent): Showtime[] {
  const today = todayLocal();
  const byCinema = new Map<string, Showtime>();
  for (const s of [...e.showtimes].sort((a, b) => a.date.localeCompare(b.date))) {
    if ((s.date >= today || timesElsewhere(s)) && !byCinema.has(s.cinema)) byCinema.set(s.cinema, s);
  }
  const shows = [...byCinema.values()];
  return [...shows.filter((s) => !timesElsewhere(s)), ...shows.filter(timesElsewhere)];
}

/** The badge next to the date: films are "Now showing"; their end is only how far ahead times are posted. */
export function untilText(e: ApiEvent): string {
  if (e.showtimes.length) return e.startLocal.slice(0, 10) > todayLocal() ? "" : "Now showing"; // not out yet: the date says when
  if (e.tags.includes("ongoing") && e.endLocal) {
    const d = dateParts(e.endLocal);
    return `Until ${d.mon} ${d.day}`;
  }
  return "";
}

/** When an event is over: its end, else a timed event's start plus 3 hours, or the end of a date-only day. */
export function endedAt(e: ApiEvent): number {
  const local = e.endLocal ?? e.startLocal;
  return Date.parse(e.end ?? e.start) + (local.length === 10 ? 24 : 3) * 3_600_000;
}

/** "Popular · 40 interested · 12 going", or "" until enough people have shown interest. */
export function popularityText(e: ApiEvent): string {
  const p = e.popularity; // saved copies from before popularity have none
  if (!p) return "";
  return [p.popular && "Popular", `${p.interested} interested`, p.going && `${p.going} going`].filter(Boolean).join(" · ");
}

/** The card's time line. */
export function whenText(e: ApiEvent): string {
  const shows = nextShowtimes(e);
  if (shows.length === 1 && timesElsewhere(shows[0])) return `Times on ${shows[0].cinema}’s site`;
  if (shows.length === 1) return `${dateParts(shows[0].date).wd}: ${shows[0].times.map(time12).join(", ")}`;
  if (shows.length > 1) return `Showtimes at ${shows.length} cinemas`;
  return e.times.length ? e.times.map(time12).join(", ") : "Start time on the listing";
}

/** The details screen's time line. */
export function timeLine(e: ApiEvent): string {
  const shows = nextShowtimes(e);
  if (shows.length === 1 && timesElsewhere(shows[0])) return `Times and tickets on ${shows[0].cinema}’s site, linked below`;
  if (shows.length) return `Showtimes at ${shows.length} ${shows.length === 1 ? "cinema" : "cinemas"}, listed below`;
  const parts = [e.times.length ? e.times.map(time12).join(", ") : "Start time on the listing"];
  if (e.tags.includes("ongoing") && e.endLocal) parts.push(`runs until ${dateParts(e.endLocal).long}`);
  return parts.join(" · ");
}

/** Sort key: date (anything already running counts as today), then all-day before timed. */
export function feedKey(e: ApiEvent, today: string): string {
  const day = e.startLocal.slice(0, 10);
  return (day < today ? today : day) + (e.allDay ? "" : e.startLocal.slice(10));
}

// ---------- calendar (.ics) ----------
const icsText = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
const icsDate = (s: string) => s.slice(0, 10).replace(/-/g, "");

/** A one-event calendar file. Timed events are in UTC, so a Calgary show saved on a Winnipeg phone lands at the
 *  right hour; all-day events are plain dates. */
export function icsFor(e: ApiEvent): string {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//wpg-events//EN", "BEGIN:VEVENT",
    `UID:${e.id}@wpg-events`, `DTSTAMP:${new Date().toISOString().replace(/[-:]|\.\d{3}/g, "")}`];
  if (e.allDay) {
    const last = parseLocal(e.endLocal ?? e.startLocal);
    last.setDate(last.getDate() + 1); // DTEND is exclusive for all-day events
    lines.push(`DTSTART;VALUE=DATE:${icsDate(e.startLocal)}`,
      `DTEND;VALUE=DATE:${last.getFullYear()}${pad(last.getMonth() + 1)}${pad(last.getDate())}`);
  } else {
    const start = new Date(e.start);
    const end = new Date(start.getTime() + 2 * 3600_000); // listings rarely give an end; assume two hours
    const fmt = (d: Date) => d.toISOString().replace(/[-:]|\.\d{3}/g, ""); // 20261124T020000Z
    lines.push(`DTSTART:${fmt(start)}`, `DTEND:${fmt(end)}`);
  }
  lines.push(`SUMMARY:${icsText(e.title)}`, `LOCATION:${icsText(placeText(e))}`, `URL:${e.url}`,
    `DESCRIPTION:${icsText(`${e.description}\n\n${e.url}`.trim())}`, "END:VEVENT", "END:VCALENDAR");
  return lines.join("\r\n");
}

export function downloadIcs(e: ApiEvent): void {
  const url = URL.createObjectURL(new Blob([icsFor(e)], { type: "text/calendar" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: `${e.title.slice(0, 40).replace(/[^\w-]+/g, "-")}.ics` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Native share sheet where there is one, else copy the link. Resolves false if the person cancelled. */
export async function shareEvent(e: ApiEvent): Promise<boolean> {
  try {
    if (navigator.share) await navigator.share({ title: e.title, url: e.url });
    else await navigator.clipboard.writeText(e.url);
    return true;
  } catch {
    return false;
  }
}
