# Meerkot

Swipe through what's on in your city: concerts, films, markets, theatre and more, gathered from
AllEvents, Ticketmaster, CinemaClock (Cineplex, Landmark and independent cinemas), Beyond 30 (over-30s daytime
clubbing) and each city's own sources, such as Tourism Winnipeg. Right saves, left passes, up shows details, down saves it for later.

Cities ([add one](#cities)):
- **Canada:** Winnipeg, Calgary, Edmonton, Halifax, Hamilton, Kelowna, Kitchener-Waterloo, London, Ottawa,
  Regina, Saskatoon, St. John's, Toronto, Vancouver and Victoria
- **Nigeria:** Lagos and Abuja (films from Silverbird Cinemas, and in Lagos, Filmhouse)

## How it fits together

```
GitHub Actions, every 6 h ──► crawler/ (Python) ──► MongoDB Atlas ◄── netlify/functions/ (/api/*)
                                                                              ▲
                                     web/ (Vite + React PWA, on Netlify) ─────┘
                                     images: Netlify Image CDN, resized from the sources
```

- **The crawler** runs on a schedule, never per visitor. Everyone reads the same stored events.
- **The API** is Netlify Functions, plus two scheduled ones: popularity every hour, reminders every 15 minutes.
  The feed is cached at Netlify's CDN, so most visits never reach MongoDB.
- **The app** keeps each person's saved, passed and later events on their device. It sends anonymous interactions
  (with a random per-device ID) in batches.

## Layout

| Path | What |
|---|---|
| `crawler/events.py` | Scrapes and categorizes events (also a standalone CLI that writes CSV/JSON) |
| `crawler/load_to_mongo.py` | Runs the crawl and upserts into MongoDB; records each run, flags broken sources |
| `crawler/suggestions.py` | Reviews the events people suggest, and adds the good ones |
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
.venv/bin/python crawler/load_places.py                    # the city search's places (GeoNames, ~3.5 MB)
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
   - **`filmhouse`:** the city's Filmhouse cinemas (Nigeria), as named under "Locations" in
     `https://www.filmhouseng.com/llms.txt`. Filmhouse doesn't say which city each is in: check their addresses.
   - **`allEventsPages`:** AllEvents pages to use instead of the usual `/<city>/all` and film pages. Check that
     the usual pages carry event data; in Lagos and Abuja only the city's home page does.
   - **The city's own event pages** that use schema.org markup (`sources`)
   - **`venueRules`** for well-known venues that mostly host one kind of event
   - **`towns`:** other names the city's events go by, for sources that file events by town (Beyond 30):
     Kitchener-Waterloo's include Cambridge
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
most linking to that showing's booking page.

**Filmhouse** (`filmhouse`: its seven Lagos cinemas, none in Abuja) lists the films it's showing in its `llms.txt`,
a page for automated readers, and each film's details on the film's page. Its times aren't public: its pages load
them from its ticketing provider's private API. So the app shows its films without times, with a **Times and
tickets** link to the film's Filmhouse page:
- A film Silverbird also shows gets that link in Silverbird's row, as a cinema with no times (a `Showtime` with
  `times: []` and a `url`). Titles match when they're the same, or when one adds a subtitle to the other and the
  running times agree ("Agbara Nla" and "Agbara Nla: The Return").
- The rest get rows of their own (source `Filmhouse`), from today, or their release date, to the Thursday that
  ends that cinema week. Films under "Coming soon" are left out.
- When a film moves from one kind of row to the other, the old row stays active until it has missed two crawls.
  The feed leaves it out meanwhile (`withoutReplacedFilms` in `netlify/lib/models.mts`).

**Genesis** shows only the rest of today's times in the page, loading other days through its site's internal
endpoint. Ask Genesis, and Filmhouse for its times, for a feed.

**Eventbrite** is off by default: it refuses requests from data centres, GitHub's included. It works from a home
connection: `CRAWL_EVENTBRITE=1 python3 crawler/load_to_mongo.py --city <slug>`. Its events still reach the app
through AllEvents, which lists many of them and links to their Eventbrite ticket pages.

**Beyond 30** runs over-30s daytime clubbing in cities worldwide, all listed on one page
(`https://www.beyond30events.com/events/`, schema.org markup; its robots.txt allows crawling). Every city's crawl
fetches it (compressed: about 95 KB) and keeps the events whose town is the city's name or one of its `towns`,
in its country, so London, Ontario doesn't get London, England's. A requested city gets its events too.
- **Times:** its dates are UTC without saying so, worked out with outdated rules where clocks changed in 2026
  (Manitoba and British Columbia: an hour out). The crawler converts them with the city's time zone, and the
  time in the description ("Time: 3:00 – 8:00pm") wins when it's within two hours.
- **Cancelled events** are left out, and sold-out ones say "Sold out" for the price. Titles lose their
  " – CITY" ending.
- **Alerts:** a city usually has one of its events every few weeks, so finding none this run isn't an alert
  (`SPARSE_SOURCES` in the loader). The page failing still is.

Event IDs include the city, except Winnipeg's, which predate cities and stay as they were.

### Cities people ask for

The city sheet is a search box and "Use my location". Results appear as you type: GeoNames' cities and towns
(15,000+ people, loaded into `places` by `crawler/load_places.py`), covered ones first.
- **A covered city** opens straight away. A place within 20 km of one counts as it (Waterloo opens
  Kitchener-Waterloo).
- **Any other city or town** can be added. Being in GeoNames' list is the check that it's a real place. The
  request is logged in `cityRequests` (one per city, with how many devices asked) and `cityRequestLog` (one per
  device and day, five at most).
- **The next scheduled crawl tries it.** `load_to_mongo.py --list-cities` adds pending requests, most asked-for
  first, up to 50 at a time; the rest wait as "waitlisted". Its settings are built from the request: AllEvents'
  city pages, Ticketmaster, and Eventbrite when switched on. Cinemas are only set up by hand.
- **It goes live** (`active`) if that crawl finds at least 5 events. From then on it's in `GET /api/cities`, its
  feed works, and the app tells whoever asked ("Events for Abeokuta are ready"). Otherwise it's `unavailable`,
  and the app says no events were found; it's tried again if someone asks after a month. A city that AllEvents
  has no page for (it redirects to its worldwide page) finds nothing, rather than someone else's events.
- **"Use my location"** opens a covered city within 25 km. Otherwise the app sends the position, rounded to 0.1°
  (about 10 km), to `GET /api/places/nearest`, which names the place and offers to add it, along with the
  nearest covered city in the meantime.

To make a requested city permanent (cinemas, local sources, venue rules), add it to `shared/cities.json`.

## Events people suggest

The **+** in the header (and a link at the end of the stack) opens **Suggest an event**. It asks for:
- a link: an Instagram post, a ticket page or the organizer's site
- the city
- an optional note for what the link doesn't say

On Android, once the app is installed, it's also in the share sheet. Sharing a post to it opens the sheet with the
link filled in (`share_target` in the manifest).

- **Storing:** `POST /api/suggestions` keeps one document per device and link in `suggestions`. Links are cleaned
  first: tracking parameters, Instagram's and Facebook's `m.` and no-`www` addresses, and trailing slashes. That
  way a post shared twice is one link. A device can send ten new links a day.
- **Already listed:** a link that's already an event in that city's feed answers "listed", nothing is stored, and
  the app offers to open the event.
- **Nothing is public until you add it.** Review with `crawler/suggestions.py`, using the crawler user's URI:

  ```sh
  python3 crawler/suggestions.py list            # new ones by city, with their notes and how many people sent each
  python3 crawler/suggestions.py draft 3f9a      # writes suggestion-3f9a0c12.json to fill in
  python3 crawler/suggestions.py add suggestion-3f9a0c12.json
  python3 crawler/suggestions.py reject 3f9a
  python3 crawler/suggestions.py remove evt_…    # an added event that was cancelled
  ```

- **Drafts:** `draft` fills in what a page says about itself, from schema.org Event data, which most ticket sites
  have. Instagram and Facebook are never fetched, because Meta doesn't allow it: type those in from the post.
  Leave their image empty, since the picture links stop working within days.
- **An added event is an ordinary event** with `manual: true`. The crawler's own code builds it, so the time zone,
  category, ID and cost work the same way, and it shows "via Instagram" (or the link's site).
  - The crawl never marks it removed, since no source lists it. It leaves the feed when it ends and is deleted 30
    days later.
  - Its ID comes from its city, title and day, like a crawled event's. If a crawl later finds the same event, it
    updates that one document.
- **Counts:** `npm run metrics` shows links by city: new, added and rejected.

## Going, reminders and popularity

- **I'm going:** a button in an event's details. Going events are saved too and tagged in Saved.
- **Did you go?** Saved events that ended in the last 30 days ask Yes / No / It didn't happen, then Good / Not
  great. Events stay in the database 30 days after they end (`KEEP_AFTER_END` in the loader) so answers count.
- **Popularity:** `event-stats.mts` runs hourly (`netlify/lib/stats.mts`): per event, the people who saw, saved,
  went, tapped tickets, calendar, share or map, answered and rated. The feed shows "40 interested" or "Popular"
  only from 10 people.
- **Reminders** (Web Push): at 6 pm the day before and 2 hours before a timed event (not 10 pm to 8 am), at 9 am on
  the day for a date-only one; none for films or running exhibitions. `send-reminders.mts` runs every 15 minutes
  and sends each one once. Set them up with `npx web-push generate-vapid-keys`, then `VAPID_PUBLIC_KEY`,
  `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT` (a `mailto:` address) in Netlify; without the keys the app doesn't
  offer them. On iPhone they need the app on the Home Screen (iOS 16.4+). The service worker's part is
  `web/public/push-sw.js`; tapping one opens `/?event=…&from=reminder`.
- **Install prompt:** after 3 saves, "Add it to your home screen?" (Chrome and Edge prompt; iPhone gets the steps).

## Tests

```sh
npm test                  # API: every endpoint, against a throwaway MongoDB
npm run typecheck
python3 -m unittest discover -s crawler/tests
MONGODB_TEST_URI=mongodb://127.0.0.1:27018 .venv/bin/python -m unittest discover -s crawler/tests   # + loader against MongoDB
```

The scheduled functions run only on Netlify. To run their work once against your database:
`npm run job:stats` (popularity) and `npm run job:reminders` (needs the VAPID keys). `npm run metrics` prints the
rollout numbers: consent rate, return in week 2 and week 5, saves, Going, "Did you go?" answers, reminders,
installs, and each city's latest crawl.

## Deploy

**MongoDB Atlas**
1. Create a cluster in the same AWS region as your Netlify site's functions.
2. Create three database users:
   - **app:** read on `events` and `places`; readWrite on `interactions`, `userEventState`, `cityRequests`,
     `cityRequestLog`, `eventStats`, `reminders`, `tallies` and `suggestions`
   - **crawler:** readWrite on `events`, `runs`, `places`, `cityRequests` and `suggestions` (`suggestions.py`
     uses it too)
   - **admin:** for `npm run db:setup` only
3. Network access: Netlify Functions and GitHub Actions have no fixed IP addresses, so allow `0.0.0.0/0` and rely
   on strong passwords.
4. Create the indexes and load the places: **Actions → Set up places and indexes → Run workflow**. It uses the
   secret `MONGODB_ADMIN_URI` if there is one, else `MONGODB_CRAWLER_URI`. Or locally:
   `MONGODB_URI=<admin URI> npm run db:setup`, then `MONGODB_URI=<crawler URI> python3 crawler/load_places.py`.
   Run it again after an update that adds indexes, and yearly to refresh the places.

**Netlify:** create a site from this repo. `netlify.toml` sets the build, the publish folder, the functions and the
image hosts. Under Environment variables, add `MONGODB_URI` (the app user) and `MONGODB_DB`; `VITE_OPERATOR_NAME`
and `VITE_PRIVACY_EMAIL` for the privacy notice (see [Privacy](#privacy)); `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`
and `VAPID_SUBJECT` for reminders (see [Going, reminders and popularity](#going-reminders-and-popularity)); and
optionally `AFFILIATE_LINKS` (see [Tickets](#tickets)).

**Crawler:** in the GitHub repo's Settings → Secrets and variables → Actions:
- secret `MONGODB_CRAWLER_URI`
- optionally, secret `TICKETMASTER_API_KEY` and variable `MONGODB_DB`

It runs every 6 hours, and Actions → Crawl events → Run workflow crawls now. A failed run means a source
stopped returning events or most of the crawl failed; the run's output says which.

## API

| | |
|---|---|
| `GET /api/events` | A city's feed, soonest first. `city` (default: the first city), and filters `category`, `tag`, `from`, `to`, `limit` (≤ 500). Films carry each cinema's next two days of showtimes. CDN-cached. |
| `GET /api/cities` | Every city with a feed (including requested ones that went live), with its event count. CDN-cached. |
| `GET /api/places?q=` | Cities and towns starting with `q` (2+ characters), covered ones first, each with its covered `city` or its request status. Cached briefly. |
| `GET /api/places/nearest?lat=&lon=` | The nearest city or town (position rounded to 0.1°), and the nearest covered city |
| `POST /api/city-requests` | `{ deviceId, placeId }`: "add my city". Answers `covered`, `pending`, `waitlisted` or `unavailable`; 429 after 5 a day from one device |
| `POST /api/suggestions` | `{ deviceId, city, url, note? }`: "suggest an event", stored for review. Answers `received`, or `listed` with the `eventId` when it's already in that city's feed; 429 after 10 new links a day from one device |
| `GET /api/events/:id` | One event, including recently removed ones, with all its showtimes |
| `POST /api/interactions` | `{ deviceId, items: [{ id, eventId, action, at, context }] }`, ≤ 50 items. Safe to retry. |
| `GET /api/me/state` | This device's saved / passed / later events (`X-Device-Id` header) |
| `GET /api/me/export` | "Download my data": everything stored for this device, with event titles where still listed |
| `DELETE /api/me` | Delete everything stored for this device, its city requests, suggestions and reminders included |
| `GET /api/reminders/key` | The public key browsers subscribe to reminders with; 404 until the VAPID keys are set |
| `PUT /api/reminders` | `{ deviceId, subscription, events }`: reminders on, for these saved events (push services only) |
| `DELETE /api/reminders` | Reminders off (`X-Device-Id` header) |
| `POST /api/tally` | `{ tally }`: adds one to today's anonymous count (`consent_yes`, `consent_no`, `installed`) |

Actions: `view`, `details`, `save`, `pass`, `later`, `unsave`, `undo`, `open_link`, `tickets`, `map`, `share`, `calendar`.

## Tickets

Nothing is sold here; the app sends people to the seller.
- **Seller pages:** when an event's page sells tickets itself (Eventbrite, Ticketmaster; the list is in
  `netlify/lib/tickets.mts`), the API adds a `tickets` link and the app shows **Get tickets on …**.
- **AllEvents:** each event's own page names its seller, through AllEvents' own affiliate link. The crawler fetches
  that page, at most once a day per event, and stores the seller's plain URL as `ticketUrl`. Use
  `--skip-ticket-links` for a quicker crawl.
- **Films:** CinemaClock has a "buy" link for each showing, which goes straight to the cinema's checkout (Cineplex,
  Landmark…). Each time in the app's showtimes is that link. Filmhouse's times aren't public, so its films link to
  their Filmhouse page (**Times and tickets**).
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
| `events` | event | Stable `_id`, so re-crawls update in place. `status` becomes `removed` after two missed runs (not for events added from suggestions, `manual: true`), and the document is deleted 30 days after the event ends (for "Did you go?" answers) |
| `interactions` | swipe, tap or click | Append-only; the `_id` comes from the device, so resent items are ignored; kept until the device deletes its data |
| `userEventState` | device × event | Current saved / passed / later; a late batch can't overwrite a newer swipe |
| `runs` | crawl | Per-source counts, errors and status |
| `places` | city or town | GeoNames' places with 15,000+ people: name, region, country, currency, time zone, position |
| `cityRequests` | requested city | Its place's details, how many devices asked, and its status after crawls |
| `cityRequestLog` | request | Device, place and time; for the daily limit; kept until the device deletes its data |
| `suggestions` | device × link | City, cleaned link, note, when; `status` new, added (with the `eventId`) or rejected; kept until the device deletes its data |
| `eventStats` | event anyone acted on | Hourly: people (not taps) who saw, saved, went, tapped tickets…; "Did you go?" answers; ratings; a score; `popular` for the top tenth of a city's current events with 10+ interested. Kept after the event, with its title |
| `reminders` | device with reminders on | Its push subscription, the saved events ahead, and which reminders were sent |
| `tallies` | day | Anonymous counts: consent answers, installs, reminders sent |

Every event has a `city` (Winnipeg's from before cities have none, and count as Winnipeg's). Each city's crawl
only marks its own events removed, and compares its total with that city's last run. A run is an alert (the
job fails, and GitHub emails you) when a source errors and finds nothing, or a source that found events last
time finds none.

Films keep their synopsis separately (`synopsis`, `synopsisCheckedAt`). Every city's crawl reuses any synopsis
fetched in the past week, in any city, so each film's page is fetched about once a week, not every run.

Times are stored twice. `start`/`end` are UTC for sorting. `startLocal`/`times` are the city's wall-clock time
as listed, and the app displays those, so outdated time-zone rules can't shift them.

## Privacy

The privacy notice is in the app (Saved → Privacy notice, and at `/privacy`):
[web/src/components/Privacy.tsx](web/src/components/Privacy.tsx). Keep it in step with what the code collects,
and change its date when it changes. It shows `VITE_OPERATOR_NAME` and `VITE_PRIVACY_EMAIL` from Netlify's
environment variables; the build warns when the email isn't set.

- **No accounts.** Each device gets a random ID.
- **Activity is opt-in.** The Discover screen asks once ("Help improve the feed?"), and nothing is recorded or
  sent until the answer is yes. The switch in Saved changes it. People who used the app before the question are
  asked too, and anything they had queued is dropped if they say no.
- **Kept until deleted.** Interactions, saved states, city requests and suggestions have no expiry. "Delete my
  data" erases them and starts a new device ID; "Download my data" (`GET /api/me/export`) gives a JSON file of all
  of it, including the device ID, which someone can send in if they lose the app before deleting.
- **Reminders are opt-in too,** offered after someone saves an event with a set time. Only then does the server get
  a push subscription and the saved events ahead; turning them off, or "Delete my data", removes both.
- **Suggestions** are sent only when someone taps Send, with the device ID. An event added from one doesn't say
  who suggested it, and it stays listed after they delete their data.
- **Counts with no ID:** the consent answers (so "No thanks" can be counted) and installs, per day.
- **Popularity** shows only once 10 people have shown interest in an event.
- **Location:** "Use my location" finds a covered city within 25 km on the phone. Otherwise the position goes to
  the API rounded to about 10 km, only to name the place, and isn't stored.
- **No third parties on page load.** Fonts are served with the app (Fontsource packages), and event images come
  through the image CDN (the original host only if the CDN can't fetch it). Google Maps, ticket sellers and
  organizers get a visit only when someone taps a link to them.

Before a public launch, have a lawyer review the notice: Canada's PIPEDA, the Nigeria Data Protection Act (2023),
and the law in any country a requested city adds. Keeping data with no time limit is a choice to check with them:
both laws expect data to be kept only as long as it's needed.

Place names come from [GeoNames](https://www.geonames.org) (CC BY 4.0); the city sheet credits it.

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
- **Organizers posting their own events**, if suggestions show there's demand:
  - a form with an emailed link to edit or cancel
  - then "connect your Instagram" to fill it in from a post, which needs Meta's app review and business
    verification
- **More Nigerian cinemas:** Genesis, and Filmhouse's times, through a feed from them (see [Cities](#cities)).
- **Before going public:**
  - review each source's terms of use
  - a legal review of the privacy notice (see [Privacy](#privacy)), and whether to register with Nigeria's NDPC
  - decide between linking organizers' images and re-hosting them through the image CDN
