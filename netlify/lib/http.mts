import type { Context } from "@netlify/functions";
import { MongoServerSelectionError } from "mongodb";

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const EVENT_ID = /^evt_[0-9a-f]{16}$/;

export function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { ...init, headers });
}

export function error(status: number, message: string): Response {
  return json({ error: message }, { status, headers: { "cache-control": "no-store" } });
}

/** Wraps a handler so a failure becomes a logged 503 (database down) or 500, not a crash. */
export function handler(fn: (req: Request, context: Context) => Promise<Response>) {
  return async (req: Request, context: Context): Promise<Response> => {
    try {
      return await fn(req, context);
    } catch (err) {
      if (err instanceof MongoServerSelectionError) {
        console.error(`MongoDB isn't reachable (${err.message}). Check MONGODB_URI; locally, is \`npm run db:local\` running?`);
        return error(503, "The events database isn't reachable right now");
      }
      console.error(err);
      return error(500, "Something went wrong");
    }
  };
}

/** The feed only changes when the crawler runs (every 6 h), so the CDN can answer most requests. */
export const FEED_CACHE = {
  "cache-control": "public, max-age=60",
  "netlify-cdn-cache-control": "public, durable, s-maxage=600, stale-while-revalidate=3600",
};
