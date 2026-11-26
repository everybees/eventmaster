import type { ApiEvent } from "../../../shared/types.ts";
import { styleFor } from "../categories.ts";
import { cityName } from "../city.ts";
import { dateParts } from "../format.ts";
import { IconX } from "./icons.tsx";

interface Props {
  events: ApiEvent[];
  trackingOff: boolean;
  onOpen(event: ApiEvent): void;
  onRemove(event: ApiEvent): void;
  onTrackingChange(off: boolean): void;
  onDeleteData(): void;
}

export function Saved({ events, trackingOff, onOpen, onRemove, onTrackingChange, onDeleteData }: Props) {
  const sorted = [...events].sort((a, b) => a.startLocal.localeCompare(b.startLocal));
  // saved in more than one city (say, on a trip): a heading per city
  const byCity = new Map<string, ApiEvent[]>();
  for (const e of sorted) byCity.set(cityName(e.city), [...(byCity.get(cityName(e.city)) ?? []), e]);
  const groups = [...byCity].sort(([a], [b]) => a.localeCompare(b));
  return (
    <div className="saved">
      <header className="header">
        <div>
          <h1>Saved</h1>
          <p className="subtitle">{sorted.length} {sorted.length === 1 ? "event" : "events"}, soonest first</p>
        </div>
      </header>
      {sorted.length === 0 && (
        <p className="saved-empty">Nothing saved yet. Swipe right on an event, or tap Save, and it lands here.</p>
      )}
      {groups.map(([name, list]) => (
        <section key={name} aria-label={groups.length > 1 ? name : undefined}>
          {groups.length > 1 && <h2 className="saved-city">{name}</h2>}
          <ul className="saved-list">
            {list.map((e) => {
              const style = styleFor(e.category);
              const d = dateParts(e.startLocal);
              return (
                <li className="saved-item" key={e.id}>
                  <button type="button" className="saved-open" onClick={() => onOpen(e)}>
                    <span className="saved-date" style={{ background: style.fill, color: style.on }}>
                      <span className="mon">{d.mon}</span>
                      <span className="day">{d.day}</span>
                    </span>
                    <span className="saved-text">
                      <span className="saved-title">{e.title}</span>
                      <span className="saved-meta">{style.short} · {e.venue.name || cityName(e.city)}</span>
                    </span>
                  </button>
                  <button type="button" className="saved-remove" aria-label={`Remove ${e.title}`} onClick={() => onRemove(e)}>
                    <IconX size={18} />
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      <section className="privacy" aria-label="Privacy">
        <p>
          Your saved list stays on this phone. To improve the feed, the app also sends what you swipe, with a random
          ID for this device. No name or email. “Use my location” rounds your position to about 10 km and uses
          it only to find your city; a city you ask us to add is logged with this device’s ID.
        </p>
        <label className="toggle">
          <input type="checkbox" checked={!trackingOff} onChange={(e) => onTrackingChange(!e.target.checked)} />
          <span>Share anonymous activity</span>
        </label>
        <button type="button" className="text-btn" onClick={onDeleteData}>Delete my data</button>
      </section>
    </div>
  );
}
