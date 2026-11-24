# Winnipeg Events

Swipe through what's on in your city: concerts, films, markets, theatre and more, gathered from
AllEvents, Ticketmaster, CinemaClock (Cineplex, Landmark and independent cinemas) and each city's own
sources, such as Tourism Winnipeg. Right saves, left passes, up shows details, down saves it for later.

Cities ([add one](#cities)):
- **Canada:** Winnipeg, Calgary, Edmonton, Halifax, Hamilton, Kelowna, Kitchener-Waterloo, London, Ottawa,
  Regina, Saskatoon, St. John's, Toronto, Vancouver and Victoria
- **Nigeria:** Lagos and Abuja (films from Silverbird Cinemas)

## How it fits together

```
GitHub Actions, every 6 h ──► crawler/ (Python) ──► MongoDB Atlas ◄── netlify/functions/ (/api/*)
                                                                              ▲
                                     web/ (Vite + React PWA, on Netlify) ─────┘
                                     images: Netlify Image CDN, resized from the sources
```

- **The crawler** runs on a schedule, never per visitor. Everyone reads the same stored events.
- **The API** is five Netlify Functions. The feed is cached at Netlify's CDN, so most visits never reach MongoDB.
- **The app** keeps each person's saved, passed and later events on their device. It sends anonymous interactions
  (with a random per-device ID) in batches.

## Layout

| Path | What |
|---|---|
| `crawler/events.py` | Scrapes and categorizes events (also a standalone CLI that writes CSV/JSON) |
| `crawler/load_to_mongo.py` | Runs the crawl and upserts into MongoDB; records each run, flags broken sources |
| `netlify/functions/` | `events`, `event`, `cities`, `interactions`, `me` (one file per endpoint) |
| `netlify/lib/` | Database connection, validation, document types, index definitions |
| `shared/` | `types.ts` and `event.schema.json`: the event shape the crawler, API and app agree on; `cities.json`: the cities and their sources |
| `web/` | The PWA |
| `scripts/` | `db-local` (a throwaway local MongoDB) and `setup-db` (create indexes) |
| `tests/` | API tests against a throwaway MongoDB |
| `.github/workflows/crawl.yml` | The scheduled crawl |

## Run it locally

Needs Node 22.18+ and Python 3.11+.

```sh
npm install
python3 -m venv .venv && .venv/bin/pip install -r crawler/requirements.txt
cp .env.example .env

npm run db:local          # terminal 1, leave it running: MongoDB on :27018 (first run downloads it, ~140 MB)
npm run db:setup          # terminal 2: create the indexes
set -a; . ./.env; set +a
.venv/bin/python crawler/load_to_mongo.py                  # crawl Winnipeg into it (~5 minutes)
.venv/bin/python crawler/load_to_mongo.py --city calgary   # and Calgary

npm run dev:web           # http://localhost:5173
```

`npm run dev:web` serves `/api/*` from `netlify/functions` through a small Vite plugin. Images load
straight from the sources, because the image CDN only exists on Netlify. For the full Netlify setup
(image CDN, Netlify's routing), install the CLI (`npm i -g netlify-cli`) and run `npm run dev`, then open
http://localhost:8888.

`python3 crawler/events.py [--city calgary]` still works on its own: it crawls and writes
`winnipeg_events.csv`/`.json` (or `calgary_…`) with no database involved.

## Cities

Each city is an entry in `shared/cities.json`. The crawler, the API (`GET /api/cities`) and the scheduled
crawl all read it. The first entry is the default city. To add a city:

1. Copy an entry and fill in:
   - **Name, region (may be empty), country, time zone, currency and coordinates.** "Use my location" picks
     the nearest city within 150 km. The currency is for prices whose listing doesn't name one.
   - **Eventbrite and AllEvents city names:** the city part of their URLs, e.g. `canada--calgary` and `calgary`.
2. Where they apply (leave them out otherwise):
   - **`ticketmaster`:** its city name, where Ticketmaster sells (North America, Europe, Australia and NZ)
   - **`cinemaclock`:** the city's cinemas (Canada only). CinemaClock lists them, nearest first, at
     `https://www.cinemaclock.com/<city>-<province>/movie-theaters`. Use the part after `/movie-theaters/` in
     each cinema's link. Keep the ones whose address is in the city (or its own districts, like Scarborough
     or Kanata), and leave out neighbouring towns and closed cinemas.
   - **`silverbird`:** the city's Silverbird cinemas (Nigeria): `{slug, name, address}`, the slug being the part
     after `/cinema/` in `https://silverbirdcinemas.com/cinema/<slug>/`
   - **`allEventsPages`:** AllEvents pages to use instead of the usual `/<city>/all` and film pages. Check that
     the usual pages carry event data; in Lagos and Abuja only the city's home page does.
   - **The city's own event pages** that use schema.org markup (`sources`)
   - **`venueRules`** for well-known venues that mostly host one kind of event
3. Check it: `python3 crawler/events.py --city <slug> --days 7`
4. Push. The next scheduled crawl includes the new city, as a job of its own (three cities run at a time).

French-language cities (Montréal, Québec City) need French keywords in the category rules first; without them
most of their events would land in "Other".

**Prices** show in the listing's own currency when it names one (a Lagos show priced in US dollars reads
"US$25"), else in the city's (₦, $).

**Nigeria:** AllEvents is the source for now. Eventbrite has many Lagos and Abuja events but only works from a
home connection (see below). tix.africa sits behind Cloudflare's bot check, so it can't be crawled; its events
arrive through AllEvents, with "Get tickets on Tix Africa" buttons, and a partner feed would be the way to list
them all.

Films in Nigeria come from **Silverbird Cinemas** (`silverbird` in a city's entry: Galleria and Ikeja in Lagos,
Jabi and the Entertainment Centre in Abuja). Each cinema's page lists the week's showtimes (Friday to Thursday),
most linking to that showing's booking page. The other chains don't publish theirs in a way the crawler should
use: **Filmhouse** loads showtimes from its ticketing provider's private API (its pages only list the films), and
**Genesis** shows only the rest of today's in the page, loading other days through its site's internal endpoint.
Ask them for a feed before adding either.

**Eventbrite** is off by default: it refuses requests from data centres, GitHub's included. It works from a home
connection: `CRAWL_EVENTBRITE=1 python3 crawler/load_to_mongo.py --city <slug>`. Its events still reach the app
through AllEvents, which lists many of them and links to their Eventbrite ticket pages.

Event IDs include the city, except Winnipeg's, which predate cities and stay as they were.

## Tests

```sh
npm test                  # API: every endpoint, against a throwaway MongoDB
npm run typecheck
python3 -m unittest discover -s crawler/tests
MONGODB_TEST_URI=mongodb://127.0.0.1:27018 .venv/bin/python -m unittest discover -s crawler/tests   # + loader against MongoDB
```

## Deploy

**MongoDB Atlas**
1. Create a cluster in the same AWS region as your Netlify site's functions.
2. Create three database users:
   - **app:** read on `events`; readWrite on `interactions` and `userEventState`
   - **crawler:** readWrite on `events` and `runs`
   - **admin:** for `npm run db:setup` only
3. Network access: Netlify Functions and GitHub Actions have no fixed IP addresses, so allow `0.0.0.0/0` and rely
   on strong passwords.
4. `MONGODB_URI=<admin URI> npm run db:setup`
   Run it again after an update that adds indexes (the per-city ones, for example).

**Netlify:** create a site from this repo. `netlify.toml` sets the build, the publish folder, the functions and the
image hosts. Under Environment variables, add `MONGODB_URI` (the app user) and `MONGODB_DB`, and optionally
`AFFILIATE_LINKS` (see [Tickets](#tickets)).

**Crawler:** in the GitHub repo's Settings → Secrets and variables → Actions:
- secret `MONGODB_CRAWLER_URI`
- optionally, secret `TICKETMASTER_API_KEY` and variable `MONGODB_DB`

It runs every 6 hours, and Actions → Crawl events → Run workflow crawls now. A failed run means a source
stopped returning events or most of the crawl failed; the run's output says which.

## API

| | |
|---|---|
| `GET /api/events` | A city's feed, soonest first. `city` (default: the first city), and filters `category`, `tag`, `from`, `to`, `limit` (≤ 500). Films carry each cinema's next two days of showtimes. CDN-cached. |
| `GET /api/cities` | Every city, with its event count. CDN-cached. |
| `GET /api/events/:id` | One event, including recently removed ones, with all its showtimes |
| `POST /api/interactions` | `{ deviceId, items: [{ id, eventId, action, at, context }] }`, ≤ 50 items. Safe to retry. |
| `GET /api/me/state` | This device's saved / passed / later events (`X-Device-Id` header) |
| `DELETE /api/me` | Delete everything stored for this device |

Actions: `view`, `details`, `save`, `pass`, `later`, `unsave`, `undo`, `open_link`, `tickets`, `map`, `share`, `calendar`.

## Tickets

Nothing is sold here; the app sends people to the seller.
- **Seller pages:** when an event's page sells tickets itself (Eventbrite, Ticketmaster; the list is in
  `netlify/lib/tickets.mts`), the API adds a `tickets` link and the app shows **Get tickets on …**.
- **AllEvents:** each event's own page names its seller, through AllEvents' own affiliate link. The crawler fetches
  that page, at most once a day per event, and stores the seller's plain URL as `ticketUrl`. Use
  `--skip-ticket-links` for a quicker crawl.
- **Films:** CinemaClock has a "buy" link for each showing, which goes straight to the cinema's checkout (Cineplex,
  Landmark…). Each time in the app's showtimes is that link.
- **Other paid events** without a known seller show **Find tickets on …**, linking to the listing.
- **Taps** on any of these are recorded as the `tickets` action, which shows how many people want to buy.

**Affiliate links:** after joining a seller's affiliate program, add `AFFILIATE_LINKS` to Netlify's environment
variables (available to Functions), then redeploy:

```
AFFILIATE_LINKS={"ticketmaster.ca":"https://<tracking link from the program>?u={url}"}
```

`{url}` becomes the URL-encoded event page, the "deep link" form most affiliate networks use (check the program's
own format). Those links get `rel="sponsored"` and a "We may earn a commission" note under the button, which
Canadian and US advertising rules expect.

## Data

| Collection | One document per | Notes |
|---|---|---|
| `events` | event | Stable `_id`, so re-crawls update in place. `status` becomes `removed` after two missed runs, and the document is deleted a day after the event ends |
| `interactions` | swipe, tap or click | Append-only; the `_id` comes from the device, so resent items are ignored; deleted after ~18 months |
| `userEventState` | device × event | Current saved / passed / later; a late batch can't overwrite a newer swipe |
| `runs` | crawl | Per-source counts, errors and status |

Every event has a `city` (Winnipeg's from before cities have none, and count as Winnipeg's). Each city's crawl
only marks its own events removed, and compares its total with that city's last run. A run is an alert (the
job fails, and GitHub emails you) when a source errors and finds nothing, or a source that found events last
time finds none.

Films keep their synopsis separately (`synopsis`, `synopsisCheckedAt`). Every city's crawl reuses any synopsis
fetched in the past week, in any city, so each film's page is fetched about once a week, not every run.

Times are stored twice. `start`/`end` are UTC for sorting. `startLocal`/`times` are the city's wall-clock time
as listed, and the app displays those, so outdated time-zone rules can't shift them.

## Privacy

There are no accounts yet. Each device gets a random ID. Interactions carry no name, email, IP or location,
and the app has a switch to stop sending them, plus a "Delete my data" button. "Use my location" asks the
browser for a position and works out the nearest city on the phone; the position is never sent anywhere. Venues
and cinemas link to Google Maps; Google gets nothing unless someone taps one. Before a public launch, add a
privacy notice: Canada's PIPEDA expects meaningful consent.

## Not done yet

- **Parser tests:** use saved copies of each source page, so a site redesign fails a test, not production.
- **Crawler data fixes:**
  - Eventbrite prices and start times (from each event's page)
  - near-duplicate merging
  - replacing the dead True North source with the Burton Cummings Theatre page
- **Rate limiting** on `POST /api/interactions`.
- **A "You" tab** for the city and privacy settings (they're in the header and the Saved tab for now).
- **Venue rules and local sources** for the newer cities (only Winnipeg and Calgary have them).
- **Start times** for AllEvents events, from the event page the crawler already opens for ticket links.
- **Accounts:** link a device's `deviceId` to a `userId` at sign-in, and sync `userEventState`.
- **More Nigerian cinemas:** Filmhouse and Genesis, through a feed from them (see [Cities](#cities)).
- **Before going public:**
  - review each source's terms of use
  - a privacy notice for each country: PIPEDA in Canada, the Nigeria Data Protection Act (2023) in Nigeria
  - decide between linking organizers' images and re-hosting them through the image CDN
