import {
  ACTIONS, ANSWERS, RATINGS, SWIPE_STATES, VIAS,
  type Action, type Answer, type InteractionContext, type Rating, type SwipeState, type Via,
} from "../../shared/types.ts";
import { EVENT_ID, UUID } from "./http.mts";

export const MAX_ITEMS = 50;
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;  // queued offline for up to a week
const MAX_FUTURE_MS = 5 * 60 * 1000;      // device clocks drift a little

export interface Item {
  id: string;
  eventId: string;
  action: Action;
  at: Date;
  context: InteractionContext;
}

export type Batch = { deviceId: string; items: Item[]; rejected: number };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => list.includes(v as T);

/** Checks a POST /api/interactions body. A malformed batch is an error; a malformed item is just dropped. */
export function parseBatch(body: unknown, now = new Date()): Batch | { error: string } {
  if (!isObject(body)) return { error: "Body must be a JSON object" };
  const { deviceId, items } = body;
  if (typeof deviceId !== "string" || !UUID.test(deviceId)) return { error: "deviceId must be a UUID" };
  if (!Array.isArray(items) || items.length === 0) return { error: "items must be a non-empty array" };
  if (items.length > MAX_ITEMS) return { error: `At most ${MAX_ITEMS} items per request` };
  const parsed = items.map((raw) => parseItem(raw, now));
  const ok = parsed.filter((i): i is Item => i !== null);
  return { deviceId: deviceId.toLowerCase(), items: ok, rejected: parsed.length - ok.length };
}

function parseItem(raw: unknown, now: Date): Item | null {
  if (!isObject(raw)) return null;
  const { id, eventId, action, at, context } = raw;
  if (typeof id !== "string" || !UUID.test(id)) return null;
  if (typeof eventId !== "string" || !EVENT_ID.test(eventId)) return null;
  if (!oneOf(ACTIONS, action)) return null;
  const when = typeof at === "string" ? new Date(at) : null;
  if (!when || Number.isNaN(when.getTime())) return null;
  if (when.getTime() < now.getTime() - MAX_AGE_MS || when.getTime() > now.getTime() + MAX_FUTURE_MS) return null;
  const ctx = parseContext(context, action);
  // an answer or a rating without its value says nothing
  if ((action === "attended" && !ctx.answer) || (action === "rated" && !ctx.rating)) return null;
  return { id: id.toLowerCase(), eventId, action, at: when, context: ctx };
}

function parseContext(raw: unknown, action: Action): InteractionContext {
  const ctx: InteractionContext = {};
  if (!isObject(raw)) return action === "undo" ? { restoredState: null } : ctx;
  if (oneOf<Via>(VIAS, raw.via)) ctx.via = raw.via;
  if (Number.isInteger(raw.position) && (raw.position as number) >= 0 && (raw.position as number) < 10_000) {
    ctx.position = raw.position as number;
  }
  if (typeof raw.filter === "string" && raw.filter.length <= 60) ctx.filter = raw.filter;
  if (action === "undo") ctx.restoredState = oneOf<SwipeState>(SWIPE_STATES, raw.restoredState) ? raw.restoredState : null;
  if (action === "attended" && oneOf<Answer>(ANSWERS, raw.answer)) ctx.answer = raw.answer;
  if (action === "rated" && oneOf<Rating>(RATINGS, raw.rating)) ctx.rating = raw.rating;
  return ctx;
}

/** The state an action leaves an event in, or undefined if it doesn't change it (view, share, going, …).
 *  Going implies saved: the app sends a "save" too when the event wasn't saved yet. */
export function nextState(item: Item): SwipeState | null | undefined {
  switch (item.action) {
    case "save": return "saved";
    case "pass": return "passed";
    case "later": return "later";
    case "unsave": return null;
    case "undo": return item.context.restoredState ?? null;
    default: return undefined;
  }
}
