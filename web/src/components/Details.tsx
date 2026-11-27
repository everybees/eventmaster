import { useEffect, useRef, type ReactNode } from "react";
import type { Action, ApiEvent, SwipeState, Tickets } from "../../../shared/types.ts";
import { styleFor } from "../categories.ts";
import { cityName } from "../city.ts";
import {
  dateParts, downloadIcs, mapsUrl, nextShowtimes, popularityText, priceNote, priceText, shareEvent, shortSource, tagText,
  timesElsewhere,
  time12, timeLine, venueMapUrl,
} from "../format.ts";
import type { Decision } from "./CardStack.tsx";
import { EventMedia } from "./EventMedia.tsx";
import {
  IconArrowLeft, IconBookmark, IconCalendar, IconCheck, IconExternal, IconPin, IconShare, IconTicket, IconX,
} from "./icons.tsx";

interface Props {
  event: ApiEvent;
  state: SwipeState | undefined;
  going: boolean;
  onGoing(on: boolean): void;
  onClose(): void;
  onDecide(decision: Exclude<Decision, "later">): void;
  onUnsave(): void;
  onTrack(action: Action): void;
}

interface RowProps {
  icon: ReactNode;
  title: string;
  sub?: string;
  map?: { href: string; onOpen(): void }; // the whole row opens Google Maps
}

function Row({ icon, title, sub, map }: RowProps) {
  const body = (
    <>
      <span className="row-icon">{icon}</span>
      <div>
        <strong>{title}</strong>
        {sub && <span>{sub}</span>}
      </div>
    </>
  );
  if (!map) return <div className="row">{body}</div>;
  return (
    <a className="row row-link" href={map.href} target="_blank" rel="noopener noreferrer"
      aria-label={`${title}${sub ? `, ${sub}` : ""}: open in Google Maps`} onClick={map.onOpen}>
      {body}
      <span className="row-go" aria-hidden="true">Map <IconExternal size={14} /></span>
    </a>
  );
}

/**
 * The way to buy, if there is one: the seller's own page (Eventbrite, Ticketmaster), or for a paid event
 * on a listings site, that listing, which links on to the seller.
 */
function buyLink(event: ApiEvent, source: string): (Tickets & { label: string }) | null {
  // saved copies from before tickets existed have no `tickets` field
  const tickets = event.tickets ?? null;
  if (tickets) return { ...tickets, label: `Get tickets on ${tickets.seller}` };
  if (event.cost === "Paid") return { url: event.url, seller: source, affiliate: false, label: `Find tickets on ${source}` };
  return null;
}

export function Details({ event, state, going, onGoing, onClose, onDecide, onUnsave, onTrack }: Props) {
  const style = styleFor(event.category);
  const tags = tagText(event);
  const shows = nextShowtimes(event);
  const source = shortSource(event.source);
  const buy = buyLink(event, source);
  const venueMap = venueMapUrl(event);
  const popularity = popularityText(event);
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
          {popularity && <p className="pop-line">{popularity}</p>}
        </div>
        <div className="rows">
          <Row icon={<IconCalendar size={18} />} title={dateParts(event.startLocal).long} sub={timeLine(event)} />
          <Row icon={<IconPin size={18} />} title={event.venue.name || cityName(event.city)} sub={event.venue.address}
            map={venueMap ? { href: venueMap, onOpen: () => onTrack("map") } : undefined} />
          <Row icon={<IconTicket size={18} />} title={priceText(event)} sub={priceNote(event)} />
          {buy && (
            <div className="buy">
              <a className="link-btn ticket" href={buy.url} target="_blank"
                rel={buy.affiliate ? "sponsored noopener noreferrer" : "noopener noreferrer"}
                onClick={() => onTrack("tickets")}>
                {buy.label} <IconExternal size={16} />
              </a>
              {buy.affiliate && <p className="fine">We may earn a commission if you buy through this link.</p>}
            </div>
          )}
          {shows.length > 0 && (
            <div className="section">
              <h3>Showtimes</h3>
              {shows.some((s) => s.tickets?.some(Boolean)) && <p className="fine left">Tap a time to buy tickets.</p>}
              {shows.map((s) => timesElsewhere(s) ? (
                // a chain that keeps its times on its own site (Filmhouse): which of its cinemas, and when, is there
                <div className="show" key={s.cinema}>
                  <div className="show-cinema plain"><strong>{s.cinema}</strong></div>
                  {s.address && <span>{s.address}</span>}
                  <div className="show-times">
                    <a className="time-chip out" href={s.url} target="_blank" rel="noopener noreferrer"
                      aria-label={`Times and tickets at ${s.cinema}, on its site`} onClick={() => onTrack("tickets")}>
                      Times and tickets <IconExternal size={14} />
                    </a>
                  </div>
                </div>
              ) : (
                <div className="show" key={s.cinema}>
                  <a className="show-cinema" href={mapsUrl([s.cinema, s.address].filter(Boolean).join(", "), cityName(event.city))}
                    target="_blank" rel="noopener noreferrer" aria-label={`${s.cinema}: open in Google Maps`}
                    onClick={() => onTrack("map")}>
                    <IconPin size={15} /> <strong>{s.cinema}</strong>
                  </a>
                  <span>{dateParts(s.date).long}</span>
                  <div className="show-times">
                    {s.times.map((t, i) => {
                      const link = s.tickets?.[i]; // saved copies from before ticket links have none
                      return link ? (
                        <a key={t} className="time-chip" href={link} target="_blank" rel="noopener noreferrer"
                          aria-label={`Buy tickets for ${time12(t)} at ${s.cinema}`} onClick={() => onTrack("tickets")}>
                          {time12(t)}
                        </a>
                      ) : (
                        <span key={t} className="time-chip off">{time12(t)}</span>
                      );
                    })}
                  </div>
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
            {!buy && (
              <a className="link-btn wide" href={event.url} target="_blank" rel="noopener noreferrer" onClick={() => onTrack("open_link")}>
                Open on {source} <IconExternal size={16} />
              </a>
            )}
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
          <>
            <button type="button" className="bar-btn" onClick={onUnsave}>Remove</button>
            <button type="button" className={going ? "bar-btn going" : "bar-btn primary"} aria-pressed={going}
              onClick={() => onGoing(!going)}>
              {going ? <><IconCheck /> Going</> : "I’m going"}
            </button>
          </>
        ) : (
          <>
            <button type="button" className="bar-btn" onClick={() => onDecide("pass")}><IconX /> Pass</button>
            <button type="button" className="bar-btn primary" onClick={() => onDecide("save")}><IconBookmark /> Save</button>
            <button type="button" className="bar-btn" aria-pressed={false} onClick={() => onGoing(true)}>Going</button>
          </>
        )}
      </div>
    </dialog>
  );
}
