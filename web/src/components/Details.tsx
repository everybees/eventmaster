import { useEffect, useRef, type ReactNode } from "react";
import type { Action, ApiEvent, SwipeState } from "../../../shared/types.ts";
import { styleFor } from "../categories.ts";
import {
  dateParts, downloadIcs, nextShowtimes, priceNote, priceText, shareEvent, shortSource, tagText, time12, timeLine,
} from "../format.ts";
import type { Decision } from "./CardStack.tsx";
import { EventMedia } from "./EventMedia.tsx";
import { IconArrowLeft, IconBookmark, IconCalendar, IconExternal, IconPin, IconShare, IconTicket, IconX } from "./icons.tsx";

interface Props {
  event: ApiEvent;
  state: SwipeState | undefined;
  onClose(): void;
  onDecide(decision: Exclude<Decision, "later">): void;
  onUnsave(): void;
  onTrack(action: Action): void;
}

function Row({ icon, title, sub }: { icon: ReactNode; title: string; sub?: string }) {
  return (
    <div className="row">
      <span className="row-icon">{icon}</span>
      <div>
        <strong>{title}</strong>
        {sub && <span>{sub}</span>}
      </div>
    </div>
  );
}

export function Details({ event, state, onClose, onDecide, onUnsave, onTrack }: Props) {
  const style = styleFor(event.category);
  const tags = tagText(event);
  const shows = nextShowtimes(event);
  const source = shortSource(event.source);
  // a native modal: Escape closes it, focus stays inside, and the feed behind is inert
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = dialog.current;
    if (d && !d.open) d.showModal();
    return () => d?.close();
  }, []);

  return (
    <dialog ref={dialog} className="details" aria-labelledby="details-title"
      onCancel={(e) => { e.preventDefault(); onClose(); }}>
      <div className="details-scroll">
        <EventMedia key={event.id} event={event} width={900} className="hero">
          <button type="button" className="icon-btn back" aria-label="Back" onClick={onClose} autoFocus>
            <IconArrowLeft />
          </button>
        </EventMedia>
        <div className="details-head">
          <div className="pills">
            <span className="pill" style={{ background: style.fill, color: style.on }}>{event.category}</span>
            {tags && <span className="pill plain">{tags}</span>}
          </div>
          <h2 id="details-title">{event.title}</h2>
        </div>
        <div className="rows">
          <Row icon={<IconCalendar size={18} />} title={dateParts(event.startLocal).long} sub={timeLine(event)} />
          <Row icon={<IconPin size={18} />} title={event.venue.name || "Winnipeg"} sub={event.venue.address} />
          <Row icon={<IconTicket size={18} />} title={priceText(event)} sub={priceNote(event)} />
          {shows.length > 0 && (
            <div className="section">
              <h3>Showtimes</h3>
              {shows.map((s) => (
                <div className="show" key={s.cinema}>
                  <strong>{s.cinema}</strong>
                  <span>{dateParts(s.date).long} · {s.times.map(time12).join(", ")}</span>
                </div>
              ))}
            </div>
          )}
          <div className="section">
            <h3>About</h3>
            <p className="about">
              {event.description || `The ${source} listing doesn’t include a description. Open it for the full details.`}
            </p>
          </div>
          <div className="links">
            <a className="link-btn wide" href={event.url} target="_blank" rel="noopener noreferrer" onClick={() => onTrack("open_link")}>
              Open on {source} <IconExternal size={16} />
            </a>
            <button type="button" className="link-btn" onClick={() => { downloadIcs(event); onTrack("calendar"); }}>
              <IconCalendar size={18} /> Add to calendar
            </button>
            <button type="button" className="link-btn" onClick={async () => { if (await shareEvent(event)) onTrack("share"); }}>
              <IconShare size={18} /> Share
            </button>
          </div>
        </div>
      </div>
      <div className="bottom-bar">
        {state === "saved" ? (
          <button type="button" className="bar-btn" onClick={onUnsave}>Remove from saved</button>
        ) : (
          <>
            <button type="button" className="bar-btn" onClick={() => onDecide("pass")}><IconX /> Pass</button>
            <button type="button" className="bar-btn primary" onClick={() => onDecide("save")}><IconBookmark /> Save</button>
          </>
        )}
      </div>
    </dialog>
  );
}
