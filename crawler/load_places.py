#!/usr/bin/env python3
"""
load_places.py — load GeoNames' list of cities and towns (15,000+ people, about 34,000 places) into
MongoDB's `places` collection. The app's city search, "Use my location" and the check that a requested
city exists all use it, so none of them needs an outside service.

  npm run db:setup                                   # first: creates the indexes the searches use
  MONGODB_URI=… python3 crawler/load_places.py       # downloads the files from GeoNames (~3.5 MB)
  python3 crawler/load_places.py --dir ~/geonames    # or reads copies already downloaded

Place data © GeoNames (https://www.geonames.org), CC BY 4.0: the app credits it in the city search.
Places change slowly; running this once a year is plenty. Needs pymongo.
"""
import argparse, io, os, sys, urllib.request, zipfile

from events import norm  # the search key, as netlify/lib/places.mts makes it from what people type

GEONAMES = "https://download.geonames.org/export/dump/"
CITIES, REGIONS, COUNTRIES = "cities15000.zip", "admin1CodesASCII.txt", "countryInfo.txt"


def read(name, folder):
    if folder:
        with open(os.path.join(folder, name), "rb") as f:
            return f.read()
    req = urllib.request.Request(GEONAMES + name, headers={"User-Agent": "city-events-places-loader"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


def places(folder=None):
    """One document per place, from GeoNames' tab-separated files."""
    countries = {}
    for line in read(COUNTRIES, folder).decode("utf-8").splitlines():
        if line and not line.startswith("#"):
            c = line.split("\t")
            countries[c[0]] = (c[4], c[10] or None)  # name, currency code
    regions = dict(line.split("\t")[:2] for line in read(REGIONS, folder).decode("utf-8").splitlines() if line)
    with zipfile.ZipFile(io.BytesIO(read(CITIES, folder))) as z:
        rows = z.read("cities15000.txt").decode("utf-8").splitlines()
    for row in rows:
        c = row.split("\t")
        gid, name, ascii_name, lat, lon, cc, admin1, pop, tz = c[0], c[1], c[2], c[4], c[5], c[8], c[10], c[14], c[17]
        country, currency = countries.get(cc, (cc, None))
        yield {
            "_id": int(gid),
            "name": name,
            "ascii": ascii_name or name,
            "key": norm(ascii_name or name),
            "region": regions.get(f"{cc}.{admin1}", ""),
            "country": cc,
            "countryName": country,
            "currency": currency,
            "timezone": tz,
            "population": int(pop or 0),
            "lat": float(lat),
            "lon": float(lon),
            "location": {"type": "Point", "coordinates": [float(lon), float(lat)]},
        }


def main():
    ap = argparse.ArgumentParser(description="Load GeoNames' cities into MongoDB's `places`.")
    ap.add_argument("--dir", help="read the GeoNames files from this folder instead of downloading them")
    args = ap.parse_args()
    uri = os.environ.get("MONGODB_URI")
    if not uri:
        sys.exit("MONGODB_URI is not set")
    from pymongo import MongoClient, ReplaceOne
    docs = list(places(args.dir))
    with MongoClient(uri) as client:
        db = client[os.environ.get("MONGODB_DB") or "wpg_events"]
        for i in range(0, len(docs), 2000):
            db.places.bulk_write([ReplaceOne({"_id": d["_id"]}, d, upsert=True) for d in docs[i:i + 2000]], ordered=False)
        print(f"Loaded {len(docs)} places into {db.name}.places")
    return 0


if __name__ == "__main__":
    sys.exit(main())
