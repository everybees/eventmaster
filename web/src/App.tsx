import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Action, ApiEvent, City, SwipeState, Via } from "../../shared/types.ts";
import { deleteMyData, fetchCities, fetchEvents } from "./api.ts";
import { CATEGORY_ORDER, styleFor } from "./categories.ts";
import { cachedCities, cityName, rememberCities, saveCity, savedCity } from "./city.ts";
import { CardStack, type Decision, type StackHandle } from "./components/CardStack.tsx";
import { CityPicker } from "./components/CityPicker.tsx";
import { Details } from "./components/Details.tsx";
import {
  IconBookmark, IconChevronDown, IconClock, IconCompass, IconInfo, IconRefresh, IconUndo, IconX,
} from "./components/icons.tsx";
import { Saved } from "./components/Saved.tsx";
import { resetDeviceId } from "./device.ts";
import { ALL, countByCategory, inCategory, remaining } from "./feed.ts";
import { useSwipeStore } from "./store.ts";
import { clearQueue, isOptedOut, setOptedOut, track } from "./track.ts";

const STATE_FOR: Record<Decision, SwipeState> = { save: "saved", pass: "passed", later: "later" };
const VERB: Record<Decision, string> = { save: "Saved", pass: "Passed on", later: "Moved to the back:" };
const HINT = "Drag the card: ← pass · save → · ↑ details · ↓ later";
const KEYS: Record<string, Decision | undefined> = { ArrowLeft: "pass", ArrowRight: "save", ArrowDown: "later" };

export function App() {
  const [city, setCity] = useState<string | null>(savedCity);
  const [cities, setCities] = useState<City[] | null>(cachedCities);
  const [picking, setPicking] = useState(() => savedCity() === null); // first visit: ask where they are
  const [events, setEvents] = useState<ApiEvent[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [store, dispatch] = useSwipeStore();
  const [category, setCategory] = useState(ALL);
  const [tab, setTab] = useState<"discover" | "saved">("discover");
  const [open, setOpen] = useState<ApiEvent | null>(null);
  const [toast, setToast] = useState("");
  const [trackingOff, setTrackingOff] = useState(isOptedOut);
  const stack = useRef<StackHandle>(null);
  const toastTimer = useRef(0);
  const lastViewed = useRef("");

  const loadCities = useCallback(() => {
    fetchCities().then(({ cities, defaultCity }) => {
      rememberCities(cities, defaultCity);
      setCities(cities);
    }, () => {}); // the picker offers "Try again" when there's no list at all
  }, []);
  useEffect(loadCities, [loadCities]);

  // the feed for the chosen city; a reply for a city that's no longer chosen is dropped
  const [reloads, setReloads] = useState(0);
  const load = useCallback(() => setReloads((n) => n + 1), []);
  useEffect(() => {
    if (!city) return;
    let current = true;
    setLoadError(null);
    fetchEvents(city).then(
      (list) => current && setEvents(list),
      (err: Error) => current && setLoadError(err.message),
    );
    return () => { current = false; };
  }, [city, reloads]);

  function pickCity(slug: string) {
    setPicking(false);
    if (slug === city) return;
    saveCity(slug);
    setCity(slug);
    setEvents(null);
    setCategory(ALL);
  }

  const queue = useMemo(() => remaining(events ?? [], store), [events, store]);
  const counts = useMemo(() => countByCategory(queue), [queue]);
  const visible = useMemo(() => inCategory(queue, category), [queue, category]);
  const top = visible[0];
  // the saved copy, refreshed from the feed while the event is in it (new times, prices, ticket links)
  const savedEvents = useMemo(() => {
    const fresh = new Map((events ?? []).map((e) => [e.id, e]));
    return Object.values(store.saved).map((e) => fresh.get(e.id) ?? e);
  }, [events, store.saved]);

  // one "view" each time a new card reaches the top of the stack
  useEffect(() => {
    if (top && tab === "discover" && top.id !== lastViewed.current) {
      lastViewed.current = top.id;
      track("view", top.id, { position: 0, filter: category });
    }
  }, [top, tab, category]);

  const say = (text: string) => {
    setToast(text);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(""), 2600);
  };

  function decide(event: ApiEvent, decision: Decision, via: Via) {
    dispatch({ type: "decide", event, next: STATE_FOR[decision] });
    track(decision, event.id, { via, filter: category });
    say(`${VERB[decision]} ${event.title}`);
  }

  function undo() {
    const step = store.history.at(-1);
    if (!step) return;
    dispatch({ type: "undo" });
    track("undo", step.event.id, { restoredState: step.prev });
    if (category !== ALL && step.event.category !== category) setCategory(step.event.category);
    say(`Undone: ${step.event.title}`);
  }

  function openDetails(event: ApiEvent, via: Via) {
    setOpen(event);
    track("details", event.id, { via, filter: category });
  }

  function unsave(event: ApiEvent) {
    dispatch({ type: "unsave", id: event.id });
    track("unsave", event.id, { via: "list" });
    say(`Removed ${event.title} from saved`);
  }

  async function deleteData() {
    if (!window.confirm("Delete your saved events and everything this app has sent about this device?")) return;
    try {
      await deleteMyData();
      clearQueue();
      resetDeviceId();
      dispatch({ type: "clear" });
      say("Your data was deleted");
    } catch (err) {
      say((err as Error).message);
    }
  }

  // arrow keys on a keyboard do what the swipes do
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (tab !== "discover" || open || picking || e.target instanceof HTMLInputElement) return;
      const decision = KEYS[e.key];
      if (decision) stack.current?.fling(decision);
      else if (e.key === "ArrowUp" && top) openDetails(top, "button");
      else return;
      e.preventDefault();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  });

  const chips = [ALL, ...CATEGORY_ORDER.filter((c) => counts.get(c) || c === category)];
  const noCards = !top;
  let body: ReactNode;
  if (!city) {
    body = (
      <div className="message">
        <p>Pick a city to see what’s on.</p>
        <button type="button" className="bar-btn" onClick={() => setPicking(true)}>Choose a city</button>
      </div>
    );
  } else if (loadError) {
    body = (
      <div className="message">
        <p>{loadError}</p>
        <button type="button" className="bar-btn" onClick={load}>Try again</button>
      </div>
    );
  } else if (!events) {
    body = <div className="message"><p>Loading events…</p></div>;
  } else if (events.length === 0) {
    body = <NoEvents onReload={load} />;
  } else if (top) {
    body = <CardStack ref={stack} events={visible.slice(0, 3)} onDecide={decide} onOpen={openDetails} />;
  } else {
    body = (
      <EmptyState
        category={category}
        hasSaved={savedEvents.length > 0}
        onBrowseAll={category !== ALL && queue.length > 0 ? () => setCategory(ALL) : undefined}
        onRestart={Object.values(store.states).some((s) => s !== "saved") ? () => dispatch({ type: "restart" }) : undefined}
      />
    );
  }

  return (
    <main className="app">
      {tab === "discover" ? (
        <div className="screen">
          <header className="header">
            <div>
              <h1>
                <button type="button" className="city-btn" aria-haspopup="dialog" onClick={() => setPicking(true)}>
                  {city ? cityName(city) : "Pick a city"} <IconChevronDown size={22} weight={2.5} />
                </button>
              </h1>
              <p className="subtitle">{!city ? "" : events ? `This month · ${queue.length} events to go` : "Loading…"}</p>
            </div>
            <button type="button" className="icon-btn" aria-label="Reload events" onClick={load} disabled={!city}><IconRefresh /></button>
          </header>
          <nav className="chips" aria-label="Categories">
            {chips.map((c) => (
              <button type="button" key={c} className="chip" aria-pressed={category === c} onClick={() => setCategory(c)}>
                {c !== ALL && <span className="dot" style={{ background: styleFor(c).fill }} aria-hidden="true" />}
                {c === ALL ? "All" : styleFor(c).short}
                <span className="count">{c === ALL ? queue.length : counts.get(c) ?? 0}</span>
              </button>
            ))}
          </nav>
          <p className="hint" aria-live="polite">{toast || (top ? HINT : "")}</p>

          {body}

          <div className="actions">
            <ActionButton label="Undo" onClick={undo} disabled={store.history.length === 0}><IconUndo /></ActionButton>
            <ActionButton label="Pass" big onClick={() => stack.current?.fling("pass")} disabled={noCards}><IconX size={28} weight={2.25} /></ActionButton>
            <ActionButton label="Details" tone="details" onClick={() => top && openDetails(top, "button")} disabled={noCards}><IconInfo /></ActionButton>
            <ActionButton label="Save" big tone="save" onClick={() => stack.current?.fling("save")} disabled={noCards}><IconBookmark size={26} weight={2.25} /></ActionButton>
            <ActionButton label="Later" tone="later" onClick={() => stack.current?.fling("later")} disabled={noCards}><IconClock /></ActionButton>
          </div>
        </div>
      ) : (
        <Saved
          events={savedEvents}
          trackingOff={trackingOff}
          onOpen={(e) => openDetails(e, "list")}
          onRemove={unsave}
          onTrackingChange={(off) => { setOptedOut(off); setTrackingOff(off); }}
          onDeleteData={deleteData}
        />
      )}

      <nav className="tabbar" aria-label="Sections">
        <button type="button" className="tab" aria-current={tab === "discover" ? "page" : undefined} onClick={() => setTab("discover")}>
          <IconCompass size={22} /><span>Discover</span>
        </button>
        <button type="button" className="tab" aria-current={tab === "saved" ? "page" : undefined} onClick={() => setTab("saved")}>
          <IconBookmark size={22} /><span>Saved · {savedEvents.length}</span>
        </button>
      </nav>

      {picking && (
        <CityPicker
          cities={cities}
          current={city}
          firstRun={!city}
          onPick={pickCity}
          onClose={() => setPicking(false)}
          onRetry={loadCities}
        />
      )}

      {open && (
        <Details
          event={open}
          state={store.states[open.id]}
          onClose={() => setOpen(null)}
          onDecide={(d) => { decide(open, d, "button"); setOpen(null); }}
          onUnsave={() => { unsave(open); setOpen(null); }}
          onTrack={(action: Action) => track(action, open.id, { via: "button" })}
        />
      )}
    </main>
  );
}

/** The server has no events at all (as opposed to: you've swiped through them). */
function NoEvents({ onReload }: { onReload(): void }) {
  return (
    <div className="stack">
      <div className="empty">
        <h2>No events yet</h2>
        <p>
          {import.meta.env.DEV
            ? "The database is empty. Load it with the crawler (README → Run it locally), then reload."
            : "Nothing is listed right now. Check back soon."}
        </p>
        <div className="empty-actions">
          <button type="button" className="bar-btn" onClick={onReload}>Reload</button>
        </div>
      </div>
    </div>
  );
}

/** You've swiped through everything (in this category). */
function EmptyState({ category, hasSaved, onBrowseAll, onRestart }: {
  category: string; hasSaved: boolean; onBrowseAll?: () => void; onRestart?: () => void;
}) {
  let note = "Check back soon for more.";
  if (onRestart) note = "Start over to see the events you passed again.";
  else if (hasSaved) note = "Your saved events are in the Saved tab.";
  return (
    <div className="stack">
      <div className="empty">
        <h2>{category === ALL ? "You’re all caught up" : `No more ${styleFor(category).short} events`}</h2>
        <p>{note}</p>
        <div className="empty-actions">
          {onBrowseAll && <button type="button" className="bar-btn primary" onClick={onBrowseAll}>Browse all</button>}
          {onRestart && <button type="button" className="bar-btn" onClick={onRestart}>Start over</button>}
        </div>
      </div>
    </div>
  );
}

function ActionButton({ label, big, tone, disabled, onClick, children }: {
  label: string; big?: boolean; tone?: "save" | "details" | "later"; disabled?: boolean;
  onClick(): void; children: ReactNode;
}) {
  return (
    <div className={["action", big && "big", tone].filter(Boolean).join(" ")}>
      <button type="button" aria-label={label} disabled={disabled} onClick={onClick}>{children}</button>
      <span aria-hidden="true">{label}</span>
    </div>
  );
}
