# Winnipeg Events

Swipe through what's on in Winnipeg: concerts, films, markets, theatre and more, gathered from
Eventbrite, AllEvents, Tourism Winnipeg, the Cinematheque and CinemaClock (Cineplex, Landmark and
independent cinemas). Right saves, left passes, up shows details, down saves it for later.

## How it fits together

```
GitHub Actions, every 6 h ──► crawler/ (Python) ──► MongoDB Atlas ◄── netlify/functions/ (/api/*)
                                                                              ▲
                                     web/ (Vite + React PWA, on Netlify) ─────┘
                                     images: Netlify Image CDN, resized from the sources
```

- **The crawler** runs on a schedule, never per visitor. Everyone reads the same stored events.
- **The API** is four Netlify Functions. The feed is cached at Netlify's CDN, so most visits never reach MongoDB.
- **The app** keeps each person's saved, passed and later events on their device. It sends anonymous interactions
  (with a random per-device ID) in batches.

## Layout

| Path | What |
|---|---|
| `crawler/events.py` | Scrapes and categorizes events (also a standalone CLI that writes CSV/JSON) |
| `crawler/load_to_mongo.py` | Runs the crawl and upserts into MongoDB; records each run, flags broken sources |
| `netlify/functions/` | `events`, `event`, `interactions`, `me` (one file per endpoint) |
| `netlify/lib/` | Database connection, validation, document types, index definitions |
| `shared/` | `types.ts` and `event.schema.json`: the event shape the crawler, API and app agree on |
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
.venv/bin/python crawler/load_to_mongo.py   # crawl into it (~2 minutes)

npm run dev:web           # http://localhost:5173
```

`npm run dev:web` serves `/api/*` from `netlify/functions` through a small Vite plugin. Images load
straight from the sources, because the image CDN only exists on Netlify. For the full Netlify setup
(image CDN, Netlify's routing), install the CLI (`npm i -g netlify-cli`) and run `npm run dev`, then open
http://localhost:8888.

`python3 crawler/events.py` still works on its own: it crawls and writes `winnipeg_events.csv`/`.json`
with no database involved.

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

**Netlify:** create a site from this repo. `netlify.toml` sets the build, the publish folder, the functions and the
image hosts. Under Environment variables, add `MONGODB_URI` (the app user) and `MONGODB_DB`.

**Crawler:** in the GitHub repo's Settings → Secrets and variables → Actions:
- secret `MONGODB_CRAWLER_URI`
- optionally, secret `TICKETMASTER_API_KEY` and variable `MONGODB_DB`

It runs every 6 hours, and Actions → Crawl events → Run workflow crawls now. A failed run means a source
stopped returning events or most of the crawl failed; the run's output says which.

## API

| | |
|---|---|
| `GET /api/events` | The feed, soonest first. Filters: `category`, `tag`, `from`, `to`, `limit` (≤ 500). CDN-cached. |
| `GET /api/events/:id` | One event, including recently removed ones |
| `POST /api/interactions` | `{ deviceId, items: [{ id, eventId, action, at, context }] }`, ≤ 50 items. Safe to retry. |
| `GET /api/me/state` | This device's saved / passed / later events (`X-Device-Id` header) |
| `DELETE /api/me` | Delete everything stored for this device |

Actions: `view`, `details`, `save`, `pass`, `later`, `unsave`, `undo`, `open_link`, `share`, `calendar`.

## Data

| Collection | One document per | Notes |
|---|---|---|
| `events` | event | Stable `_id`, so re-crawls update in place. `status` becomes `removed` after two missed runs, and the document is deleted a day after the event ends |
| `interactions` | swipe, tap or click | Append-only; the `_id` comes from the device, so resent items are ignored; deleted after ~18 months |
| `userEventState` | device × event | Current saved / passed / later; a late batch can't overwrite a newer swipe |
| `runs` | crawl | Per-source counts, errors and status |

Times are stored twice. `start`/`end` are UTC for sorting. `startLocal`/`times` are Winnipeg wall-clock
as listed, and the app displays those, so outdated time-zone rules can't shift them.

## Privacy

There are no accounts yet. Each device gets a random ID. Interactions carry no name, email, IP or location,
and the app has a switch to stop sending them, plus a "Delete my data" button. Before a public launch, add a
privacy notice: Canada's PIPEDA expects meaningful consent.

## Not done yet

- **Parser tests:** use saved copies of each source page, so a site redesign fails a test, not production.
- **Crawler data fixes:**
  - Eventbrite prices and start times (from each event's page)
  - near-duplicate merging
  - replacing the dead True North source with the Burton Cummings Theatre page
- **Rate limiting** on `POST /api/interactions`.
- **Accounts:** link a device's `deviceId` to a `userId` at sign-in, and sync `userEventState`.
- **Before going public:**
  - review each source's terms of use
  - decide between linking organizers' images and re-hosting them through the image CDN
