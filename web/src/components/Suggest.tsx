import { useEffect, useRef, useState, type FormEvent } from "react";
import type { City, SuggestionResponse } from "../../../shared/types.ts";
import { suggestEvent } from "../api.ts";
import { cityName } from "../city.ts";
import { IconX } from "./icons.tsx";

const NOTE_MAX = 500; // as the API's

interface Props {
  cities: City[] | null;
  city: string | null;  // the city being browsed: the one it's for, unless they pick another
  link?: string;        // shared to the app from another (Android's share sheet)
  onOpenEvent(id: string): void;
  onClose(): void;
}

/** "Know of a link in that text?" The first web address in what another app shared ("Look! https://…"). */
export const linkIn = (text: string) => /https?:\/\/[^\s<>"]+/i.exec(text)?.[0] ?? "";

/**
 * "Suggest an event": a link (an Instagram post, a ticket page, the organizer's site), the city, and a note for
 * what the link doesn't say. It's checked by a person before anything is listed (crawler/suggestions.py).
 */
export function SuggestSheet({ cities, city, link = "", onOpenEvent, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [url, setUrl] = useState(link);
  const [where, setWhere] = useState(city ?? cities?.[0]?.slug ?? "");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const [sent, setSent] = useState<SuggestionResponse | null>(null);

  useEffect(() => {
    const d = dialog.current;
    if (d && !d.open) d.showModal();
    return () => d?.close();
  }, []);

  async function send(e: FormEvent) {
    e.preventDefault();
    const address = url.trim();
    if (!address.includes(".") || /\s/.test(address)) {
      setProblem("Paste the event’s link: an Instagram post, a ticket page or the organizer’s site.");
      return;
    }
    setBusy(true);
    setProblem("");
    try {
      setSent(await suggestEvent(where, address, note.trim()));
    } catch (err) {
      setProblem((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function another() {
    setUrl("");
    setNote("");
    setSent(null);
  }

  const options = (cities ?? []).map((c) => ({ slug: c.slug, name: c.name })).sort((a, b) => a.name.localeCompare(b.name));
  if (where && !options.some((c) => c.slug === where)) options.unshift({ slug: where, name: cityName(where) });
  return (
    <dialog ref={dialog} className="sheet" aria-labelledby="suggest-title"
      onCancel={(e) => { e.preventDefault(); onClose(); }}>
      <div className="sheet-body">
        <div className="sheet-head">
          <h2 id="suggest-title">Suggest an event</h2>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}><IconX /></button>
        </div>

        {sent ? (
          <div className="outcome" role="status">
            {sent.status === "listed" ? (
              <>
                <p>That one’s already in the app.</p>
                <button type="button" className="bar-btn primary" onClick={() => sent.eventId && onOpenEvent(sent.eventId)}>Open it</button>
              </>
            ) : (
              <>
                <p>Thanks! We look at every suggestion. If it fits, it’ll be in the app within a few days.</p>
                <button type="button" className="bar-btn" onClick={another}>Suggest another</button>
              </>
            )}
            <button type="button" className="bar-btn" onClick={onClose}>Done</button>
          </div>
        ) : (
          <form className="suggest-form" onSubmit={(e) => void send(e)} noValidate>
            <p className="sheet-note">
              Know of something that isn’t here? Send us its link: an Instagram post, a ticket page or the organizer’s site.
            </p>
            <label className="field">
              <span>Link to the event</span>
              <input type="text" inputMode="url" autoComplete="off" autoCapitalize="off" spellCheck={false}
                placeholder="https://" value={url} onChange={(e) => setUrl(e.target.value)} required />
            </label>
            <label className="field">
              <span>City</span>
              <select value={where} onChange={(e) => setWhere(e.target.value)}>
                {options.map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}
              </select>
            </label>
            <label className="field">
              <span>Anything the link doesn’t say? <small>(optional)</small></span>
              <textarea rows={3} maxLength={NOTE_MAX} placeholder="The date and time, where it is, the price"
                value={note} onChange={(e) => setNote(e.target.value)} />
            </label>
            {problem && <output className="sheet-note problem">{problem}</output>}
            <button type="submit" className="bar-btn primary" disabled={busy || !where}>{busy ? "Sending…" : "Send"}</button>
            <p className="fine">
              We check every suggestion before it’s listed. It’s sent with this phone’s random ID, and deleted with your
              data. Please leave out people’s phone numbers and other personal details.
            </p>
          </form>
        )}
      </div>
    </dialog>
  );
}
