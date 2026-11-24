import { useEffect, useRef, useState } from "react";
import type { City } from "../../../shared/types.ts";
import { countryName, nearestCity } from "../city.ts";
import { IconLocate, IconX } from "./icons.tsx";

interface Props {
  cities: City[] | null;
  current: string | null;
  firstRun: boolean; // no city yet: it can't be dismissed
  onPick(slug: string): void;
  onClose(): void;
  onRetry(): void;   // the list didn't load
}

const NEAR_KM = 150; // close enough to count as "in" a city: suburbs and nearby towns

/**
 * The city sheet. "Use my location" finds the nearest city on the phone; the position is never sent anywhere.
 * With a long list, a search box appears.
 */
export function CityPicker({ cities, current, firstRun, onPick, onClose, onRetry }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [locating, setLocating] = useState(false);
  const [note, setNote] = useState("");
  const [suggested, setSuggested] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    const d = dialog.current;
    if (d && !d.open) d.showModal();
    return () => d?.close();
  }, []);

  function locate() {
    if (!cities?.length) return;
    if (!("geolocation" in navigator)) {
      setNote("This browser can’t share its location. Pick a city instead.");
      return;
    }
    setLocating(true);
    setNote("");
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        setLocating(false);
        const best = nearestCity(cities, coords.latitude, coords.longitude);
        if (!best) return;
        if (best.km <= NEAR_KM) return onPick(best.city.slug);
        setSuggested(best.city.slug);
        setNote(`There’s nothing near you yet. The closest city here is ${best.city.name}, ${Math.round(best.km).toLocaleString()} km away.`);
      },
      (err) => {
        setLocating(false);
        setNote(err.code === err.PERMISSION_DENIED
          ? "Location is off for this site. Pick a city instead."
          : "Your location couldn’t be found. Pick a city instead.");
      },
      { timeout: 10_000, maximumAge: 3_600_000 },
    );
  }

  const q = query.trim().toLowerCase();
  const shown = (cities ?? [])
    .filter((c) => !q || `${c.name} ${c.region} ${countryName(c.country)}`.toLowerCase().includes(q))
    .toSorted((a, b) => a.name.localeCompare(b.name));
  // more than one country: a heading for each, the current city's country first
  const home = cities?.find((c) => c.slug === current)?.country;
  const groups = new Map<string, City[]>();
  for (const c of shown) groups.set(c.country, [...(groups.get(c.country) ?? []), c]);
  const byCountry = [...groups].sort(([a], [b]) =>
    Number(b === home) - Number(a === home) || countryName(a).localeCompare(countryName(b)));

  return (
    <dialog ref={dialog} className="sheet" aria-labelledby="city-title"
      onCancel={(e) => { e.preventDefault(); if (!firstRun) onClose(); }}>
      <div className="sheet-body">
        <div className="sheet-head">
          <h2 id="city-title">{firstRun ? "Where are you?" : "Choose your city"}</h2>
          {!firstRun && (
            <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}><IconX /></button>
          )}
        </div>
        {firstRun && <p className="sheet-note">Pick a city to see what’s on there. You can change it any time.</p>}

        {cities === null ? (
          <div className="sheet-note">
            <p>The list of cities didn’t load.</p>
            <button type="button" className="bar-btn" onClick={onRetry}>Try again</button>
          </div>
        ) : (
          <>
            <button type="button" className="link-btn locate" onClick={locate} disabled={locating}>
              <IconLocate size={18} /> {locating ? "Finding you…" : "Use my location"}
            </button>
            {note && <output className="sheet-note">{note}</output>}
            {cities.length > 6 && (
              <input type="search" className="city-search" placeholder="Search cities" aria-label="Search cities"
                value={query} onChange={(e) => setQuery(e.target.value)} />
            )}
            {byCountry.map(([country, list]) => (
              <section key={country} className="city-group" aria-label={byCountry.length > 1 ? countryName(country) : undefined}>
                {byCountry.length > 1 && <h3 className="city-country">{countryName(country)}</h3>}
                <ul className="city-list">
                  {list.map((c) => (
                    <li key={c.slug}>
                      <button type="button" className={`city-option${c.slug === suggested ? " suggested" : ""}`}
                        aria-pressed={c.slug === current} onClick={() => onPick(c.slug)}>
                        <span className="radio" aria-hidden="true" />
                        <span>{c.region ? `${c.name}, ${c.region}` : c.name}</span>
                        <span className="city-count">{c.count} {c.count === 1 ? "event" : "events"}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
            {shown.length === 0 && <p className="sheet-note">No city matches “{query}”.</p>}
            <p className="fine">Your location stays on this phone. It’s only used to find the nearest city.</p>
          </>
        )}
      </div>
    </dialog>
  );
}
