// Interaction tracking: queued on the device, sent in batches to POST /api/interactions.
// Survives reloads and offline stretches; the server ignores items it already has, so resending is safe.
// Nothing is recorded or sent until the person says yes (the first-run notice, or the switch in Saved).
import type { Action, InteractionContext, InteractionItem } from "../../shared/types.ts";
import { sendTally } from "./api.ts";
import { deviceId } from "./device.ts";

const QUEUE_KEY = "wpg.queue";
const CONSENT_KEY = "wpg.consent";     // "yes" or "no"; missing: not asked yet
const CONSENT_VERSION_KEY = "wpg.consentVersion";
/** Raise this when the privacy notice changes what activity is collected: everyone is asked again. */
const CONSENT_VERSION = 1;
const OLD_OPT_OUT_KEY = "wpg.trackingOff"; // from before the question: "1" was "no"
const BATCH = 50;        // the API's per-request limit
const FLUSH_AT = 20;     // send early once this many are waiting
const FLUSH_MS = 10_000;
const MAX_QUEUE = 500;   // a long offline stretch keeps the newest

let queue: InteractionItem[] = readQueue();
let sending = false;

function readQueue(): InteractionItem[] {
  try {
    return JSON.parse(localStorage.getItem(QUEUE_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function saveQueue(): void {
  localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
}

export function track(action: Action, eventId: string, context: InteractionContext = {}): void {
  if (consent() !== "yes") return;
  queue.push({ id: crypto.randomUUID(), eventId, action, at: new Date().toISOString(), context });
  if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE);
  saveQueue();
  if (queue.length >= FLUSH_AT) void flush();
}

export async function flush(useBeacon = false): Promise<void> {
  if (sending || queue.length === 0 || consent() !== "yes") return;
  const batch = queue.slice(0, BATCH);
  const body = JSON.stringify({ deviceId: deviceId(), items: batch });
  if (useBeacon && navigator.sendBeacon) {
    // the page is going away: a beacon still gets delivered after it closes
    if (navigator.sendBeacon("/api/interactions", new Blob([body], { type: "application/json" }))) drop(batch);
    return;
  }
  sending = true;
  try {
    const res = await fetch("/api/interactions", {
      method: "POST", headers: { "content-type": "application/json" }, body, keepalive: true,
    });
    // a 4xx (other than rate limiting) means the batch itself is bad; retrying won't help
    if (res.ok || (res.status >= 400 && res.status < 500 && res.status !== 429)) drop(batch);
  } catch {
    // offline: keep it for the next try
  } finally {
    sending = false;
  }
}

function drop(batch: InteractionItem[]): void {
  const sent = new Set(batch.map((i) => i.id));
  queue = queue.filter((i) => !sent.has(i.id));
  saveQueue();
}

export function startTracking(): void {
  setInterval(() => void flush(), FLUSH_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void flush(true);
  });
  addEventListener("online", () => void flush());
  void flush();
}

export type Consent = "yes" | "no" | null;

/** Whether this person agreed to share their activity; null until they've been asked. */
export function consent(): Consent {
  const value = localStorage.getItem(CONSENT_KEY);
  const version = Number(localStorage.getItem(CONSENT_VERSION_KEY) ?? 1); // answers from before versions were version 1
  if (value === "yes" || value === "no") return version === CONSENT_VERSION ? value : null;
  return localStorage.getItem(OLD_OPT_OUT_KEY) === "1" ? "no" : null;
}

export function setConsent(yes: boolean): void {
  localStorage.setItem(CONSENT_KEY, yes ? "yes" : "no");
  localStorage.setItem(CONSENT_VERSION_KEY, String(CONSENT_VERSION));
  localStorage.removeItem(OLD_OPT_OUT_KEY);
  sendTally(yes ? "consent_yes" : "consent_no"); // counted without any ID, so "no" is counted too
  if (yes) {
    void flush();
  } else {
    // anything recorded before they were asked, or before they said no, is never sent
    queue = [];
    saveQueue();
  }
}

/** Forget anything not yet sent (after "delete my data"). */
export function clearQueue(): void {
  queue = [];
  saveQueue();
}
