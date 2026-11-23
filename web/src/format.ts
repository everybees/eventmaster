import type { ApiEvent, Showtime } from "../../shared/types.ts";
import { cityName } from "./city.ts";

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

export function priceText(e: ApiEvent): string {
  if (e.cost === "Free") return "Free";
  const t = e.price.text;
  if (!t || t.startsWith("Paid")) return "Price on listing";
  return /^\d/.test(t) ? `$${t.replace("–", "–$")}` : t;
}

export function priceNote(e: ApiEvent): string {
  const source = shortSource(e.source);
  return e.price.text || e.cost === "Free" ? `From the ${source} listing` : `Not in the ${source} listing`;
}

export const placeText = (e: ApiEvent) => [e.venue.name, e.venue.address].filter(Boolean).join(", ") || cityName(e.city);

export const tagText = (e: ApiEvent) => e.tags.map((t) => TAG_LABELS[t] ?? t).join(" · ");

/** Each cinema's next day with showings (films only). */
export function nextShowtimes(e: ApiEvent): Showtime[] {
  const today = todayLocal();
  const byCinema = new Map<string, Showtime>();
  for (const s of [...e.showtimes].sort((a, b) => a.date.localeCompare(b.date))) {
    if (s.date >= today && !byCinema.has(s.cinema)) byCinema.set(s.cinema, s);
  }
  return [...byCinema.values()];
}

/** The badge next to the date: films are "Now showing"; their end is only how far ahead times are posted. */
export function untilText(e: ApiEvent): string {
  if (e.showtimes.length) return "Now showing";
  if (e.tags.includes("ongoing") && e.endLocal) {
    const d = dateParts(e.endLocal);
    return `Until ${d.mon} ${d.day}`;
  }
  return "";
}

/** The card's time line. */
export function whenText(e: ApiEvent): string {
  const shows = nextShowtimes(e);
  if (shows.length === 1) return `${dateParts(shows[0].date).wd}: ${shows[0].times.map(time12).join(", ")}`;
  if (shows.length > 1) return `Showtimes at ${shows.length} cinemas`;
  return e.times.length ? e.times.map(time12).join(", ") : "Start time on the listing";
}

/** The details screen's time line. */
export function timeLine(e: ApiEvent): string {
  const shows = nextShowtimes(e);
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
