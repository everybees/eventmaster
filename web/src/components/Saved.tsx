import { useState } from "react";
import type { Answer, ApiEvent, Rating } from "../../../shared/types.ts";
import { styleFor } from "../categories.ts";
import { cityName } from "../city.ts";
import { dateParts, endedAt } from "../format.ts";
import { Brand } from "./Brand.tsx";
import { IconX } from "./icons.tsx";

/** How long after an event "Did you go?" is asked (the server keeps events this long to record the answer). */
const ASK_FOR_MS = 30 * 24 * 3_600_000;

export interface RemindersState {
  on: boolean;
  support: "yes" | "install" | "no";
  available: boolean; // the server sends reminders
}

interface Props {
  events: ApiEvent[];
  going: Record<string, true>;
  answers: Record<string, Answer>;
  sharing: boolean;
  reminders: RemindersState;
  onOpen(event: ApiEvent): void;
  onRemove(event: ApiEvent): void;
  onAnswer(event: ApiEvent, answer: Answer): void;
  onRate(event: ApiEvent, rating: Rating): void;
  onSharingChange(on: boolean): void;
  onRemindersChange(on: boolean): void;
  onPrivacy(): void;
  onDownloadData(): void;
  onDeleteData(): void;
}

/** Saved events still ahead or on, soonest first. */
export const upcoming = (events: ApiEvent[], now = Date.now()) => events.filter((e) => endedAt(e) > now);

export function Saved(p: Props) {
  const { events, going, answers, sharing, reminders } = p;
  const now = Date.now();
  const ahead = upcoming(events, now).sort((a, b) => a.startLocal.localeCompare(b.startLocal));
  const toAsk = events
    .filter((e) => endedAt(e) <= now && now - endedAt(e) < ASK_FOR_MS && !answers[e.id])
    .sort((a, b) => b.startLocal.localeCompare(a.startLocal));
  // after a "Yes", the same card asks how it was (once, in this visit)
  const [rating, setRating] = useState<ApiEvent | null>(null);

  // saved in more than one city (say, on a trip): a heading per city
  const byCity = new Map<string, ApiEvent[]>();
  for (const e of ahead) byCity.set(cityName(e.city), [...(byCity.get(cityName(e.city)) ?? []), e]);
  const groups = [...byCity].sort(([a], [b]) => a.localeCompare(b));
  const goingCount = ahead.filter((e) => going[e.id]).length;

  return (
    <div className="saved">
      <header className="header">
        <div className="header-title">
          <Brand />
          <div>
            <h1>Saved</h1>
            <p className="subtitle">
              {ahead.length} coming up{goingCount ? `, going to ${goingCount}` : ""}
            </p>
          </div>
        </div>
      </header>

      {(toAsk.length > 0 || rating) && (
        <section className="ask-list" aria-labelledby="ask-title">
          <h2 className="saved-city" id="ask-title">Did you go?</h2>
          {rating && (
            <fieldset className="ask">
              <legend className="ask-title">How was {rating.title}?</legend>
              <div className="ask-actions">
                <button type="button" className="bar-btn" onClick={() => { p.onRate(rating, "up"); setRating(null); }}>Good</button>
                <button type="button" className="bar-btn" onClick={() => { p.onRate(rating, "down"); setRating(null); }}>Not great</button>
                <button type="button" className="text-btn plain" onClick={() => setRating(null)}>Skip</button>
              </div>
            </fieldset>
          )}
          {toAsk.map((e) => (
            <fieldset className="ask" key={e.id} aria-label={`Did you go to ${e.title}?`}>
              <legend className="ask-title">{e.title}</legend>
              <p className="ask-meta">{[dateParts(e.startLocal).long, e.venue.name].filter(Boolean).join(" · ")}</p>
              <div className="ask-actions">
                <button type="button" className="bar-btn" onClick={() => { p.onAnswer(e, "yes"); setRating(e); }}>Yes</button>
                <button type="button" className="bar-btn" onClick={() => p.onAnswer(e, "no")}>No</button>
                <button type="button" className="bar-btn" onClick={() => p.onAnswer(e, "cancelled")}>It didn’t happen</button>
              </div>
            </fieldset>
          ))}
        </section>
      )}

      {ahead.length === 0 && (
        <p className="saved-empty">Nothing coming up. Swipe right on an event, or tap Save, and it lands here.</p>
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
                  <button type="button" className="saved-open" onClick={() => p.onOpen(e)}>
                    <span className="saved-date" style={{ background: style.fill, color: style.on }}>
                      <span className="mon">{d.mon}</span>
                      <span className="day">{d.day}</span>
                    </span>
                    <span className="saved-text">
                      <span className="saved-title">{e.title}</span>
                      <span className="saved-meta">
                        {going[e.id] && <span className="going-tag">Going</span>}
                        {style.short} · {e.venue.name || cityName(e.city)}
                      </span>
                    </span>
                  </button>
                  <button type="button" className="saved-remove" aria-label={`Remove ${e.title}`} onClick={() => p.onRemove(e)}>
                    <IconX size={18} />
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}

      <section className="privacy" aria-label="Reminders and privacy">
        {reminders.available && reminders.support === "yes" && (
          <label className="toggle">
            <input type="checkbox" checked={reminders.on} onChange={(e) => p.onRemindersChange(e.target.checked)} />
            <span>Reminders before saved events</span>
          </label>
        )}
        {reminders.available && reminders.support === "install" && (
          <p>Reminders on iPhone work once the app is on your Home Screen: tap Share, then Add to Home Screen.</p>
        )}
        <p>
          Your saved list is kept on this phone.{" "}
          {sharing
            ? "You’re sharing your activity (what you see, save and tap) with a random ID for this device, to improve the feed."
            : "Activity sharing is off: nothing about what you see or save is sent."}{" "}
          {reminders.on && "Reminders need the list of saved events on our server. "}
          Cities you ask us to add and events you suggest are logged with this device’s ID. We keep it all until you
          delete it.
        </p>
        <label className="toggle">
          <input type="checkbox" checked={sharing} onChange={(e) => p.onSharingChange(e.target.checked)} />
          <span>Share my activity</span>
        </label>
        <div className="privacy-links">
          <button type="button" className="text-btn plain" onClick={p.onPrivacy}>Privacy notice</button>
          <button type="button" className="text-btn plain" onClick={p.onDownloadData}>Download my data</button>
          <button type="button" className="text-btn" onClick={p.onDeleteData}>Delete my data</button>
        </div>
      </section>
    </div>
  );
}
