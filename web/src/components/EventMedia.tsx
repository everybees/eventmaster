import { useState, type ReactNode } from "react";
import type { ApiEvent } from "../../../shared/types.ts";
import { imageUrl } from "../api.ts";
import { styleFor } from "../categories.ts";

interface Props {
  event: ApiEvent;
  width: number;
  className: string;
  children?: ReactNode;
}

/**
 * The event's picture: the image CDN's resized copy, else the original, else the category colour.
 * Portrait images (film posters, flyers) are shown whole over a blurred copy rather than cropped.
 * Give it key={event.id} so a new event starts fresh.
 */
export function EventMedia({ event, width, className, children }: Props) {
  const sources = event.image ? [imageUrl(event.image, width), event.image] : [];
  const [attempt, setAttempt] = useState(0);
  const [poster, setPoster] = useState(false);
  const src = sources[attempt];
  const style = styleFor(event.category);
  return (
    <div className={className} style={{ background: style.fill }}>
      {src && poster && <img className="media-blur" src={src} alt="" draggable={false} />}
      {src && (
        <img
          className={poster ? "media-poster" : "media-img"}
          src={src}
          alt=""
          draggable={false}
          onLoad={(e) => {
            const img = e.currentTarget;
            if (img.naturalHeight > img.naturalWidth * 1.15) setPoster(true);
          }}
          onError={() => setAttempt((n) => n + 1)}
        />
      )}
      {!src && (
        <span className="watermark" style={{ color: style.on }} aria-hidden="true">
          {style.short}
        </span>
      )}
      {children}
    </div>
  );
}
