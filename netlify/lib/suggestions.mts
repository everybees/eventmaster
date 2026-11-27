import { createHash } from "node:crypto";
import type { ObjectId } from "mongodb";

/**
 * An event someone suggested ("Suggest an event" in the app): a link and a city, for a person to look at.
 * Nothing is public until it's added as an event (crawler/suggestions.py). One per device and link.
 */
export interface SuggestionDoc {
  _id?: ObjectId;
  deviceId: string;
  city: string;
  url: string;          // as cleanLink() leaves it
  key: string;          // linkKey(url): how crawler/suggestions.py names a link
  note: string;         // what they added ("Sat 7 pm, Muri Okunola Park"), "" if nothing
  at: Date;             // first sent
  updatedAt: Date;      // last sent (a resend updates the note)
  status: "new" | "added" | "rejected";
  eventId?: string;     // added: the event made from it
  reviewedAt?: Date;
}

export const SUGGESTIONS_PER_DAY = 10;
export const NOTE_MAX = 500;
const URL_MAX = 2000;

// tracking added by the app a link was shared from; the same post shared twice should be one link
const TRACKING = /^(utm_.+|fbclid|gclid|igsh|igshid|mibextid|si)$/i;
const IP_HOST = /^(\d{1,3}\.){3}\d{1,3}$|^\[/; // IPv4, or IPv6 in brackets
// the same post by its other addresses (mobile, no www): one link
const SAME_SITE: Record<string, string> = {
  "instagram.com": "www.instagram.com", "m.instagram.com": "www.instagram.com",
  "facebook.com": "www.facebook.com", "m.facebook.com": "www.facebook.com", "web.facebook.com": "www.facebook.com",
};

/**
 * A pasted link as one we can store and compare: https:// added when missing, no tracking parameters, fragment
 * or trailing slash. null unless it's a public web page's address (http or https, a domain name, no login).
 */
export function cleanLink(raw: string): string | null {
  let text = raw.trim();
  if (!text || text.length > URL_MAX || /\s/.test(text)) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(text)) text = `https://${text}`; // "instagram.com/p/…"
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  const host = url.hostname;
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
  if (!host.includes(".") || host.endsWith(".") || IP_HOST.test(host) || host === "localhost") return null;
  const tracking = [...url.searchParams.keys()].filter((name) => TRACKING.test(name)); // deleting while iterating skips some
  for (const name of tracking) url.searchParams.delete(name);
  url.hostname = SAME_SITE[host] ?? host;
  url.hash = "";
  let path = url.pathname;
  while (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  url.pathname = path;
  const out = url.toString();
  return out.length <= URL_MAX ? out : null;
}

/** "3f9a0c12": a short, stable name for a link. */
export const linkKey = (url: string) => createHash("sha1").update(url).digest("hex").slice(0, 8);
