// Event reminders: a push subscription for this browser, and the list of saved events still ahead.
// The server (netlify/lib/reminders.mts) decides when each one goes out.
import type { ApiEvent } from "../../shared/types.ts";
import { deleteReminders, fetchReminderKey, putReminders } from "./api.ts";
import { isIos, isStandalone } from "./install.ts";

const KEY = "wpg.reminders"; // "on" or "off"; missing: not offered yet
export type ReminderPref = "on" | "off" | null;

export function reminderPref(): ReminderPref {
  const v = localStorage.getItem(KEY);
  return v === "on" || v === "off" ? v : null;
}
const setPref = (v: "on" | "off") => localStorage.setItem(KEY, v);

/** "yes": this browser can get reminders; "install": an iPhone, which needs the app on the Home Screen first. */
export function reminderSupport(): "yes" | "install" | "no" {
  if ("PushManager" in window && "serviceWorker" in navigator && "Notification" in window) return "yes";
  return isIos() && !isStandalone() ? "install" : "no";
}

let key: Promise<string | null> | null = null;
/** Whether the server is set up to send reminders (asked once per page load). */
export const remindersAvailable = () => (key ??= fetchReminderKey().catch(() => null)).then(Boolean);

/** The service worker, if one is running (in development there's none). */
async function worker(): Promise<ServiceWorkerRegistration | null> {
  const timeout = new Promise<null>((r) => setTimeout(() => r(null), 4000));
  return Promise.race([navigator.serviceWorker.ready, timeout]);
}

function keyBytes(base64url: string): Uint8Array {
  const raw = atob(base64url.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (base64url.length % 4)) % 4));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/** Asks the browser's permission, subscribes, and sends the events. */
export async function turnOnReminders(events: string[]): Promise<"on" | "denied" | "unavailable"> {
  const publicKey = await (key ??= fetchReminderKey().catch(() => null));
  const reg = publicKey ? await worker() : null;
  if (!publicKey || !reg) return "unavailable";
  if ((await Notification.requestPermission()) !== "granted") return "denied";
  const subscription = (await reg.pushManager.getSubscription())
    ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) as BufferSource }));
  await putReminders(subscription.toJSON() as never, events);
  setPref("on");
  return "on";
}

/** Keeps the server's list in step with the saved events (when reminders are on). */
export async function syncReminders(events: string[]): Promise<void> {
  if (reminderPref() !== "on") return;
  const subscription = await (await worker())?.pushManager.getSubscription();
  if (subscription) await putReminders(subscription.toJSON() as never, events);
}

export async function turnOffReminders(): Promise<void> {
  setPref("off");
  try {
    await (await (await worker())?.pushManager.getSubscription())?.unsubscribe();
  } finally {
    await deleteReminders().catch(() => {});
  }
}

/** Whether an event gets reminders: films and running exhibitions don't (as in netlify/lib/reminders.mts). */
export const remindable = (e: ApiEvent) => e.showtimes.length === 0 && !e.tags.includes("ongoing");

/** "Not now": not offered again; the switch in Saved still turns them on. */
export const declineReminders = () => setPref("off");
