// Interaction tracking: queued on the device, sent in batches to POST /api/interactions.
// Survives reloads and offline stretches; the server ignores items it already has, so resending is safe.
import type { Action, InteractionContext, InteractionItem } from "../../shared/types.ts";
import { deviceId } from "./device.ts";

const QUEUE_KEY = "wpg.queue";
const OPT_OUT_KEY = "wpg.trackingOff";
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
  if (isOptedOut()) return;
  queue.push({ id: crypto.randomUUID(), eventId, action, at: new Date().toISOString(), context });
  if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE);
  saveQueue();
  if (queue.length >= FLUSH_AT) void flush();
}

export async function flush(useBeacon = false): Promise<void> {
  if (sending || queue.length === 0) return;
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

export const isOptedOut = () => localStorage.getItem(OPT_OUT_KEY) === "1";

export function setOptedOut(off: boolean): void {
  if (off) {
    localStorage.setItem(OPT_OUT_KEY, "1");
    queue = [];
    saveQueue();
  } else {
    localStorage.removeItem(OPT_OUT_KEY);
  }
}

/** Forget anything not yet sent (after "delete my data"). */
export function clearQueue(): void {
  queue = [];
  saveQueue();
}
