import type { ApiEvent } from "../../../shared/types.ts";
import { styleFor } from "../categories.ts";
import { dateParts, placeText, priceText, shortSource, tagText, untilText, whenText } from "../format.ts";
import { EventMedia } from "./EventMedia.tsx";
import { IconClock, IconPin, IconTicket } from "./icons.tsx";

/** The face of a card in the stack. */
export function EventCard({ event }: { event: ApiEvent }) {
  const style = styleFor(event.category);
  const date = dateParts(event.startLocal);
  const tags = tagText(event);
  const until = untilText(event);
  const price = priceText(event);
  const knownPrice = price !== "Price on listing";
  return (
    <>
      <EventMedia key={event.id} event={event} width={720} className="card-media">
        <span className="pill media-cat" style={{ background: style.fill, color: style.on }}>{style.short}</span>
        {tags && <span className="pill media-tags">{tags}</span>}
        <div className="media-bottom">
          <span className="date-badge">
            <span className="wd">{date.wd}</span>
            <span className="day">{date.day}</span>
            <span className="mon">{date.mon}</span>
          </span>
          {until && <span className="pill until">{until}</span>}
        </div>
      </EventMedia>
      <div className="card-body">
        <h2 className="card-title">{event.title}</h2>
        <p className="meta"><IconPin size={16} /><span className="clamp2">{placeText(event)}</span></p>
        <p className="meta"><IconClock size={16} /><span>{whenText(event)}</span></p>
        <p className="meta"><IconTicket size={16} /><span className={knownPrice ? "price" : undefined}>{price}</span></p>
        <p className="blurb clamp2">{event.description || `No description in the ${shortSource(event.source)} listing.`}</p>
        <div className="card-foot">
          <span>via {shortSource(event.source)}</span>
          <span>Tap for details</span>
        </div>
      </div>
    </>
  );
}
