import type { Db } from "mongodb";
import * as webpush from "web-push";
import type { PushSubscriptionJson } from "../../shared/types.ts";
import { liveCities } from "./cities.mts";
import type { EventDoc } from "./models.mts";
import { tally } from "./tally.mts";

/** A `reminders` document: one per device that turned reminders on. */
export interface ReminderDoc {
  _id: string;                       // the device ID
  subscription: PushSubscriptionJson;
  events: string[];                  // the saved events still ahead, as the app last sent them
  sent: string[];                    // "evt_…:day": each reminder goes out once
  createdAt: Date;
  updatedAt: Date;
}

export type ReminderKind = "day" | "soon" | "today";
export interface Reminder {
  kind: ReminderKind;
  at: Date;
  title: string;
  body: string;
  ttl: number; // seconds the push service may hold it while the phone is offline: never past the event
}

const EVENING = "18:00";             // "Tomorrow: …" goes out at 6 pm the day before a timed event
const MORNING = "09:00";             // "Today: …" at 9 am on the day of a date-only event
const SOON_MS = 2 * 3600_000;        // "In 2 hours: …"
const QUIET = { from: 22, until: 8 } as const; // no reminders from 10 pm to 8 am, local time
/** A reminder still goes out this long after its time: the job runs every 15 minutes and may be late. */
export const WINDOW_MS = 45 * 60_000;

/** The moment a wall-clock time happens in a time zone ("2026-12-05", "18:00", "America/Winnipeg"). */
export function zonedTime(date: string, hhmm: string, timeZone: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  const [h, min] = hhmm.split(":").map(Number);
  const wall = Date.UTC(y, m - 1, d, h, min);
  const offset = (t: number) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric",
    }).formatToParts(new Date(t)).map((x) => [x.type, Number(x.value)]));
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - t;
  };
  const first = wall - offset(wall);
  return new Date(wall - offset(first)); // a second pass, in case the guess fell on the other side of a clock change
}

const hourIn = (t: Date, timeZone: string) =>
  Number(new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", hour: "numeric" }).format(t));

const dayBefore = (date: string) => {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
};

function time12(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  return `${h % 12 || 12}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h < 12 ? "am" : "pm"}`;
}

/** The reminders an event gets. None for films and running exhibitions: they're on for days, not at a time. */
export function remindersFor(e: Pick<EventDoc, "title" | "startLocal" | "allDay" | "start" | "tags" | "showtimes" | "venue">,
  timeZone: string): Reminder[] {
  if (e.showtimes?.length || e.tags?.includes("ongoing")) return [];
  const date = e.startLocal.slice(0, 10);
  const venue = e.venue?.name ?? "";
  if (e.allDay) {
    return [{ kind: "today", at: zonedTime(date, MORNING, timeZone), title: `Today: ${e.title}`, body: venue, ttl: 6 * 3600 }];
  }
  const when = [time12(e.startLocal.slice(11, 16)), venue].filter(Boolean).join(" · ");
  const list: Reminder[] = [{ kind: "day", at: zonedTime(dayBefore(date), EVENING, timeZone), title: `Tomorrow: ${e.title}`, body: when, ttl: 12 * 3600 }];
  const soon = new Date(e.start.getTime() - SOON_MS);
  const hour = hourIn(soon, timeZone);
  if (hour >= QUIET.until && hour < QUIET.from) {
    list.push({ kind: "soon", at: soon, title: `In 2 hours: ${e.title}`, body: when, ttl: 90 * 60 });
  }
  return list;
}

/** Sends one notification; throws an error with `statusCode` when the push service refuses. */
export type Sender = (subscription: PushSubscriptionJson, payload: string, ttl: number) => Promise<void>;

/** The real sender, or null when the keys aren't set (then reminders are off: no offer in the app, nothing sent). */
export function webPushSender(): Sender | null {
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, URL: SITE_URL } = process.env;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return null;
  // who push services can contact about our messages: a mailto: or https: address (Netlify sets URL to the site's)
  const subject = VAPID_SUBJECT || (SITE_URL?.startsWith("https:") ? SITE_URL : "mailto:reminders@localhost.invalid");
  webpush.setVapidDetails(subject, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  return async (subscription, payload, ttl) => {
    await webpush.sendNotification(subscription, payload, { TTL: ttl, urgency: "normal" });
  };
}

export const publicKey = (): string | null => (process.env.VAPID_PRIVATE_KEY && process.env.VAPID_PUBLIC_KEY) || null;

/**
 * Sends every reminder that's due: each device's saved events, each reminder once, within WINDOW_MS of its
 * time and before the event. A subscription the push service says is gone (404, 410) is deleted.
 */
export async function sendReminders(db: Db, send: Sender, now = new Date()): Promise<{ sent: number; failed: number; removed: number }> {
  const col = db.collection<ReminderDoc>("reminders");
  const devices = await col.find({ "events.0": { $exists: true } }).toArray();
  const ids = [...new Set(devices.flatMap((d) => d.events))];
  const events = new Map((await db.collection<EventDoc>("events").find({
    _id: { $in: ids }, status: "active",
    start: { $gte: new Date(now.getTime() - 24 * 3600_000), $lte: new Date(now.getTime() + 48 * 3600_000) },
  }).toArray()).map((e) => [e._id, e]));
  const zones = new Map((await liveCities(db)).map((c) => [c.slug, c.timezone]));
  const fallbackZone = [...zones.values()].at(0) ?? "UTC"; // the first city's, for events from before cities

  const jobs: { device: ReminderDoc; key: string; reminder: Reminder; eventId: string }[] = [];
  for (const device of devices) {
    for (const id of device.events) {
      const e = events.get(id);
      if (!e) continue;
      for (const r of remindersFor(e, zones.get(e.city ?? "") ?? fallbackZone)) {
        const key = `${id}:${r.kind}`;
        const late = now.getTime() - r.at.getTime();
        const over = r.kind === "today" ? now > e.visibleUntil : now >= e.start;
        if (late >= 0 && late < WINDOW_MS && !over && !device.sent.includes(key)) jobs.push({ device, key, reminder: r, eventId: id });
      }
    }
  }

  let sent = 0, failed = 0, removed = 0;
  const gone = new Set<string>();
  const queue = [...jobs];
  const worker = async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      if (gone.has(job.device._id)) continue;
      const { title, body, ttl } = job.reminder;
      const payload = JSON.stringify({ title, body, tag: job.key, url: `/?event=${job.eventId}&from=reminder` });
      try {
        await send(job.device.subscription, payload, ttl);
        await col.updateOne({ _id: job.device._id }, { $addToSet: { sent: job.key } });
        sent++;
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          gone.add(job.device._id);
          await col.deleteOne({ _id: job.device._id });
          removed++;
        } else {
          failed++; // tried again on the next run, while still within the window
          console.error(`Reminder ${job.key} failed:`, status ?? err);
        }
      }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  if (sent) await tally(db, { reminders_sent: sent }, now);
  return { sent, failed, removed };
}

// push services browsers use; reminders are only ever sent to these (never to an arbitrary URL)
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, // Chrome, Edge on Android, Samsung, Brave, Opera
  /(^|\.)push\.apple\.com$/,                              // Safari, iPhone home-screen apps
  /(^|\.)push\.services\.mozilla\.com$/,                  // Firefox
  /(^|\.)notify\.windows\.com$/,                          // Edge on Windows
];
const B64URL = /^[A-Za-z0-9_-]{16,200}={0,2}$/;

/** A PushSubscription.toJSON() from the app, or null if it isn't one from a known push service. */
export function parseSubscription(v: unknown): PushSubscriptionJson | null {
  if (typeof v !== "object" || v === null) return null;
  const { endpoint, keys } = v as Record<string, unknown>;
  if (typeof endpoint !== "string" || endpoint.length > 1000) return null;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !PUSH_HOSTS.some((h) => h.test(url.hostname))) return null;
  if (typeof keys !== "object" || keys === null) return null;
  const { p256dh, auth } = keys as Record<string, unknown>;
  if (typeof p256dh !== "string" || typeof auth !== "string" || !B64URL.test(p256dh) || !B64URL.test(auth)) return null;
  return { endpoint, keys: { p256dh, auth } };
}
