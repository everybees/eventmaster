import type { ApiEvent } from "../../../shared/types.ts";
import { styleFor } from "../categories.ts";
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
      <ul className="saved-list">
        {sorted.map((e) => {
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
                  <span className="saved-meta">{style.short} · {e.venue.name || "Winnipeg"}</span>
                </span>
              </button>
              <button type="button" className="saved-remove" aria-label={`Remove ${e.title}`} onClick={() => onRemove(e)}>
                <IconX size={18} />
              </button>
            </li>
          );
        })}
      </ul>
      <section className="privacy" aria-label="Privacy">
        <p>
          Your saved list stays on this phone. To improve the feed, the app also sends what you swipe, with a random
          ID for this device. No name, email or location.
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
