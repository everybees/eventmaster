import type { Tickets } from "../../shared/types.ts";

/** Any of a company's country sites: eventbrite.ca, eventbrite.co.uk, ticketmaster.com.au, … */
const countrySites = (name: string) => new RegExp(String.raw`(^|\.)${name}\.(com?\.)?[a-z]{2,3}$`);

/** Sites whose event pages sell the tickets themselves; other sources' pages only describe the event. */
const SELLERS: { name: string; site: RegExp }[] = [
  { name: "Ticketmaster", site: countrySites("ticketmaster") },
  { name: "Live Nation", site: countrySites("livenation") }, // some Ticketmaster API events link here
  { name: "Eventbrite", site: countrySites("eventbrite") },
  // other ticket sites that AllEvents listings name
  { name: "TicketWeb", site: countrySites("ticketweb") },
  { name: "Showpass", site: countrySites("showpass") },
  { name: "Universe", site: countrySites("universe") },
  { name: "Fever", site: countrySites("feverup") },
  { name: "Tixr", site: countrySites("tixr") },
  { name: "Zeffy", site: countrySites("zeffy") },
];

/** Link shorteners hide where they go; "Get tickets on tinyurl.com" would say nothing useful. */
const SHORTENERS = /(^|\.)(tinyurl\.com|bit\.ly|t\.co|ow\.ly|rebrand\.ly|linktr\.ee|lnkd\.in|shorturl\.at|tiny\.cc|forms\.gle)$/;

/** How to name a seller we don't know: its domain, or "the organizer's site" behind a link shortener. */
const unknownSeller = (host: string) => (SHORTENERS.test(host) ? "the organizer’s site" : host.replace(/^www\./, ""));

const onDomain = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

/**
 * AFFILIATE_LINKS (optional): a JSON object, seller domain → the affiliate program's tracking link, with
 * {url} where the URL-encoded event page goes (the "deep link" form affiliate networks use), e.g.
 *   {"ticketmaster.ca": "https://example.affiliate-network.com/c/123/456/789?u={url}"}
 * It's read on each call (cheap: re-parsed only when it changes), so a test or a redeploy picks up a new value.
 */
let cache: { raw: string | undefined; rules: [string, string][] } = { raw: undefined, rules: [] };

function affiliateRules(): [string, string][] {
  const raw = process.env.AFFILIATE_LINKS?.trim() || undefined;
  if (raw === cache.raw) return cache.rules;
  let rules: [string, string][] = [];
  if (raw) {
    try {
      const entries = Object.entries(JSON.parse(raw) as Record<string, unknown>);
      rules = entries
        .filter((r): r is [string, string] => typeof r[1] === "string" && r[1].startsWith("https://") && r[1].includes("{url}"))
        .map(([domain, link]) => [domain.toLowerCase(), link]);
      if (rules.length < entries.length) console.warn("AFFILIATE_LINKS: ignored entries that aren't an https:// link containing {url}");
    } catch {
      console.warn("AFFILIATE_LINKS isn't valid JSON; ticket links go out without affiliate tracking");
    }
  }
  cache = { raw, rules };
  return rules;
}

/**
 * Where to buy tickets, given a page: null when it isn't a seller's. With `named`, the listing itself said
 * "buy here" (AllEvents names each event's seller), so a site we don't know counts too, shown by its domain.
 */
export function ticketsFor(url: string, named = false): Tickets | null {
  let host: string;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    host = u.hostname.toLowerCase();
  } catch {
    return null;
  }
  const seller = SELLERS.find((s) => s.site.test(host))?.name ?? (named ? unknownSeller(host) : null);
  if (!seller) return null;
  const link = affiliateRules().find(([domain]) => onDomain(host, domain))?.[1];
  return link
    ? { url: link.replaceAll("{url}", encodeURIComponent(url)), seller, affiliate: true }
    : { url, seller, affiliate: false };
}
