import { useEffect, useRef, useState } from "react";
import type { City, CityRequestResponse, PlaceResult } from "../../../shared/types.ts";
import { nearestPlace, requestCity, searchPlaces } from "../api.ts";
import { nearestCity } from "../city.ts";
import { IconLocate, IconX } from "./icons.tsx";

interface Props {
  cities: City[] | null; // the covered cities: event counts, and the nearest one to suggest meanwhile
  current: string | null;
  firstRun: boolean;     // no city yet: it can't be dismissed until there's an answer
  onPick(slug: string): void;
  onClose(): void;
  onRequested(slug: string, name: string): void; // remembered, to say when its events are ready
}

const METRO_KM = 25;      // "Use my location" picks a covered city this close without asking
const MEANWHILE_KM = 400; // suggest a covered city this close while theirs is being added

type Nearby = { slug: string; name: string; km: number };
type Outcome =
  | { kind: "near"; place: PlaceResult; nearby: Nearby | null } // located in a place we don't cover
  | { kind: "requested"; name: string; status: CityRequestResponse["status"]; nearby: Nearby | null };

/**
 * The city sheet: a search box and "Use my location", nothing else until there's something to show.
 * Covered cities open straight away. Any other city or town (GeoNames' places, so it's a real one) can be
 * added: the request is logged, the next crawl tries it, and the app says when its events are ready.
 */
export function CityPicker({ cities, current, firstRun, onPick, onClose, onRequested }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PlaceResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [locating, setLocating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  useEffect(() => {
    const d = dialog.current;
    if (d && !d.open) d.showModal();
    return () => d?.close();
  }, []);

  // search as they type, a moment after they stop
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults(null);
      return;
    }
    const ctrl = new AbortController();
    const timer = window.setTimeout(() => {
      setSearching(true);
      searchPlaces(q, ctrl.signal).then(
        (found) => { setResults(found); setSearching(false); },
        (err: Error) => {
          if (err.name === "AbortError") return;
          setResults([]);
          setSearching(false);
          setNote(err.message);
        },
      );
    }, 250);
    return () => {
      window.clearTimeout(timer);
      ctrl.abort();
    };
  }, [query]);

  function nearbyTo(lat: number, lon: number): Nearby | null {
    const best = cities?.length ? nearestCity(cities, lat, lon) : null;
    return best && best.km <= MEANWHILE_KM ? { slug: best.city.slug, name: best.city.name, km: Math.round(best.km) } : null;
  }

  async function choose(place: PlaceResult) {
    if (place.city) return onPick(place.city);
    setBusy(true);
    setNote("");
    try {
      const res = await requestCity(place.id);
      if (res.status === "covered" || res.status === "active") return onPick(res.city);
      if (res.status !== "unavailable") onRequested(res.city, res.name);
      setOutcome({ kind: "requested", name: res.name, status: res.status, nearby: nearbyTo(place.lat, place.lon) });
      setQuery("");
    } catch (err) {
      setNote((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function locate() {
    if (!("geolocation" in navigator)) {
      setNote("This browser can’t share its location. Search for your city instead.");
      return;
    }
    setLocating(true);
    setNote("");
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        const best = cities?.length ? nearestCity(cities, coords.latitude, coords.longitude) : null;
        if (best && best.km <= METRO_KM) {
          setLocating(false);
          return onPick(best.city.slug);
        }
        nearestPlace(coords.latitude, coords.longitude).then(
          ({ place, city }) => {
            setLocating(false);
            if (place?.city) return onPick(place.city);
            if (!place) return setNote("We couldn’t tell which city you’re in. Search for it instead.");
            setOutcome({ kind: "near", place, nearby: city && city.km <= MEANWHILE_KM ? city : null });
          },
          (err: Error) => {
            setLocating(false);
            setNote(err.message);
          },
        );
      },
      (err) => {
        setLocating(false);
        setNote(err.code === err.PERMISSION_DENIED
          ? "Location is off for this site. Search for your city instead."
          : "Your location couldn’t be found. Search for your city instead.");
      },
      { timeout: 10_000, maximumAge: 3_600_000 },
    );
  }

  const canClose = !firstRun || outcome !== null;
  return (
    <dialog ref={dialog} className="sheet" aria-labelledby="city-title"
      onCancel={(e) => { e.preventDefault(); if (canClose) onClose(); }}>
      <div className="sheet-body">
        <div className="sheet-head">
          <h2 id="city-title">{firstRun ? "Where are you?" : "Choose your city"}</h2>
          {canClose && <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}><IconX /></button>}
        </div>

        <input type="search" className="city-search" placeholder="Search for your city" aria-label="Search for your city"
          value={query} onChange={(e) => { setQuery(e.target.value); setOutcome(null); }} />
        <button type="button" className="link-btn locate" onClick={locate} disabled={locating}>
          <IconLocate size={18} /> {locating ? "Finding you…" : "Use my location"}
        </button>
        {note && <output className="sheet-note">{note}</output>}

        {outcome && <OutcomeCard outcome={outcome} busy={busy} onAdd={choose} onPick={onPick} />}

        {results && (
          <ul className="city-list">
            {results.map((p) => (
              <li key={`${p.id}-${p.city}`}>
                <button type="button" className="city-option" aria-pressed={p.city !== null && p.city === current}
                  disabled={busy} onClick={() => void choose(p)}>
                  <span className="radio" aria-hidden="true" />
                  <span className="city-label">
                    <span>{p.name}</span>
                    <small>{[p.region, p.countryName].filter(Boolean).join(", ")}</small>
                  </span>
                  <span className="city-count">{statusText(p, cities)}</span>
                </button>
              </li>
            ))}
            {results.length === 0 && !searching && (
              <li className="sheet-note">No city or town by that name. Try its full name.</li>
            )}
          </ul>
        )}

        <p className="fine">“Use my location” rounds your position to about 10 km to find your city. Place names: GeoNames.</p>
      </div>
    </dialog>
  );
}

/** What choosing a result does: open a covered city ("120 events"), or add or follow up on one. */
function statusText(p: PlaceResult, cities: City[] | null): string {
  if (p.city) {
    const city = cities?.find((c) => c.slug === p.city);
    if (!city) return "";
    const events = `${city.count} ${city.count === 1 ? "event" : "events"}`;
    // a place that's part of a covered city by another name: Waterloo is in Kitchener-Waterloo's feed
    return city.name === p.name ? events : `${city.name} · ${events}`;
  }
  if (p.request === "pending") return "Coming soon";
  if (p.request === "waitlisted") return "On the list";
  if (p.request === "unavailable") return "No events found yet";
  return "Add this city";
}

function OutcomeCard({ outcome, busy, onAdd, onPick }: {
  outcome: Outcome; busy: boolean; onAdd(p: PlaceResult): void; onPick(slug: string): void;
}) {
  const { nearby } = outcome;
  let message: string;
  if (outcome.kind === "near") message = `You’re in or near ${outcome.place.name}, which we don’t cover yet.`;
  else if (outcome.status === "waitlisted") message = `We’ve noted ${outcome.name}. We add a few cities at a time, and it’s on the list.`;
  else if (outcome.status === "unavailable") message = `We looked for events in ${outcome.name} and didn’t find enough yet. We’ll look again.`;
  else message = `Thanks! We’re adding ${outcome.name}. Its events usually show up within a few hours, and we’ll let you know here.`;
  return (
    <div className="outcome">
      <p>{message}</p>
      {outcome.kind === "near" && (
        <button type="button" className="bar-btn primary" disabled={busy} onClick={() => onAdd(outcome.place)}>
          Add {outcome.place.name}
        </button>
      )}
      {nearby && (
        <button type="button" className="bar-btn" onClick={() => onPick(nearby.slug)}>
          Meanwhile, see {nearby.name} ({nearby.km.toLocaleString()} km)
        </button>
      )}
    </div>
  );
}
