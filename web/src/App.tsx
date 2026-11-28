import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Action, Answer, ApiEvent, City, Rating, SwipeState, Via } from "../../shared/types.ts";
import { deleteMyData, downloadMyData, fetchCities, fetchEvent, fetchEvents } from "./api.ts";
import { CATEGORY_ORDER, styleFor } from "./categories.ts";
import {
  cachedCities, cityName, forgetRequest, rememberCities, rememberRequest, requestedCities, saveCity, savedCity,
} from "./city.ts";
import { Brand, Mascot } from "./components/Brand.tsx";
import { CardStack, type Decision, type StackHandle } from "./components/CardStack.tsx";
import { CityPicker } from "./components/CityPicker.tsx";
import { Details } from "./components/Details.tsx";
import {
  IconBookmark, IconChevronDown, IconClock, IconCompass, IconPlus, IconRefresh, IconUndo, IconX,
} from "./components/icons.tsx";
import { ConsentBanner, PrivacyNotice } from "./components/Privacy.tsx";
import { InstallPrompt, RemindersPrompt } from "./components/Prompts.tsx";
import { Saved, upcoming } from "./components/Saved.tsx";
import { linkIn, SuggestSheet } from "./components/Suggest.tsx";
import { resetDeviceId } from "./device.ts";
import { ALL, countByCategory, inCategory, remaining } from "./feed.ts";
import { dismissInstall, installDismissed, promptInstall, useInstallWay } from "./install.ts";
import {
  declineReminders, reminderPref, reminderSupport, remindable, remindersAvailable, syncReminders, turnOffReminders,
  turnOnReminders,
} from "./reminders.ts";
import { useSwipeStore } from "./store.ts";
import { clearQueue, consent, setConsent, track, type Consent } from "./track.ts";

const STATE_FOR: Record<Decision, SwipeState> = { save: "saved", pass: "passed", later: "later" };
const VERB: Record<Decision, string> = { save: "Saved", pass: "Passed on", later: "Moved to the back:" };
const HINT = "Drag the card: ← pass · save → · ↑ details · ↓ later";
const KEYS: Record<string, Decision | undefined> = { ArrowLeft: "pass", ArrowRight: "save", ArrowDown: "later" };
const SHARED = ["share_url", "share_text", "share_title"]; // the manifest's share_target (vite.config.ts)

/** A link another app shared to this one (Android's share sheet), to suggest as an event. */
function sharedLink(): { link: string } | null {
  const q = new URLSearchParams(location.search);
  if (!SHARED.some((k) => q.has(k))) return null;
  return { link: linkIn(SHARED.map((k) => q.get(k) ?? "").join(" ")) };
}

export function App() {
  const [city, setCity] = useState<string | null>(savedCity);
  const [cities, setCities] = useState<City[] | null>(cachedCities);
  const [picking, setPicking] = useState(() => savedCity() === null); // first visit: ask where they are
  const [requested, setRequested] = useState(requestedCities);
  const [events, setEvents] = useState<ApiEvent[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [store, dispatch] = useSwipeStore();
  const [category, setCategory] = useState(ALL);
  const [tab, setTab] = useState<"discover" | "saved">("discover");
  const [open, setOpen] = useState<ApiEvent | null>(null);
  const [toast, setToast] = useState("");
  const [sharing, setSharing] = useState<Consent>(consent);
  const [privacyOpen, setPrivacyOpen] = useState(() => location.pathname.replace(/\/$/, "") === "/privacy");
  const [suggesting, setSuggesting] = useState(sharedLink);
  const [remindersOn, setRemindersOn] = useState(() => reminderPref());
  const [canRemind, setCanRemind] = useState(false); // the server sends reminders
  const [installOff, setInstallOff] = useState(installDismissed);
  const installWay = useInstallWay();
  const support = useMemo(reminderSupport, []);
  useEffect(() => { void remindersAvailable().then(setCanRemind); }, []);
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

  // a city this person asked for that now has events: offer it (once)
  const ready = requested.find((r) => r.slug !== city && cities?.some((c) => c.slug === r.slug && c.count > 0));
  function dismissReady(slug: string) {
    forgetRequest(slug);
    setRequested(requestedCities());
  }

  function pickCity(slug: string) {
    setPicking(false);
    if (requested.some((r) => r.slug === slug)) dismissReady(slug);
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

  // reminders follow the saved events still ahead
  const ahead = useMemo(() => upcoming(savedEvents), [savedEvents]);
  const aheadIds = ahead.map((e) => e.id).sort().join(",");
  useEffect(() => {
    if (remindersOn === "on") void syncReminders(aheadIds ? aheadIds.split(",") : []).catch(() => {});
  }, [aheadIds, remindersOn]);

  // a shared link opened the suggestion sheet: tidy the address
  useEffect(() => {
    if (SHARED.some((k) => new URLSearchParams(location.search).has(k))) history.replaceState(null, "", "/");
  }, []);

  // a reminder's link: /?event=evt_…&from=reminder opens that event
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const id = q.get("event");
    if (!id) return;
    history.replaceState(null, "", "/");
    const via: Via = q.get("from") === "reminder" ? "reminder" : "tap";
    fetchEvent(id).then(
      (e) => { setOpen(e); track("details", e.id, { via }); },
      (err: Error) => say(err.message),
    );
  }, []);

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

  // a suggestion that's already in the app: "Open it"
  function openSuggested(id: string) {
    setSuggesting(null);
    const loaded = events?.find((e) => e.id === id);
    if (loaded) openDetails(loaded, "tap");
    else fetchEvent(id).then((e) => openDetails(e, "tap"), (err: Error) => say(err.message));
  }

  function setGoing(event: ApiEvent, on: boolean) {
    const wasSaved = store.states[event.id] === "saved";
    dispatch({ type: "going", event, on });
    if (on && !wasSaved) track("save", event.id, { via: "button", filter: category });
    track(on ? "going" : "not_going", event.id, { via: "button" });
    say(on ? `Going to ${event.title}` : `Not going to ${event.title}`);
  }

  function answer(event: ApiEvent, value: Answer) {
    dispatch({ type: "answer", id: event.id, answer: value });
    track("attended", event.id, { via: "list", answer: value });
    if (value !== "yes") say("Thanks");
  }

  function rate(event: ApiEvent, rating: Rating) {
    dispatch({ type: "rate", id: event.id, rating });
    track("rated", event.id, { via: "list", rating });
    say("Thanks");
  }

  async function reminders(on: boolean) {
    if (!on) {
      await turnOffReminders();
      setRemindersOn("off");
      say("Reminders are off");
      return;
    }
    try {
      const result = await turnOnReminders(ahead.map((e) => e.id));
      if (result === "on") say("Reminders are on");
      else if (result === "denied") { declineReminders(); say("Notifications are blocked for this site in your browser’s settings"); }
      else say("Reminders aren’t available right now");
    } catch (err) {
      say((err as Error).message);
    }
    setRemindersOn(reminderPref());
  }

  async function install(yes: boolean) {
    if (yes) await promptInstall();
    dismissInstall();
    setInstallOff(true);
  }

  function unsave(event: ApiEvent) {
    dispatch({ type: "unsave", id: event.id });
    track("unsave", event.id, { via: "list" });
    say(`Removed ${event.title} from saved`);
  }

  function answerConsent(yes: boolean) {
    setConsent(yes);
    setSharing(consent());
  }

  function closePrivacy() {
    setPrivacyOpen(false);
    if (location.pathname !== "/") history.replaceState(null, "", "/"); // opened at /privacy
  }

  async function downloadData() {
    try {
      await downloadMyData();
      say("Your data was downloaded");
    } catch (err) {
      say((err as Error).message);
    }
  }

  async function deleteData() {
    if (!window.confirm("Delete your saved events and everything this app has sent about this device?")) return;
    try {
      await deleteMyData();
      if (remindersOn === "on") await turnOffReminders().catch(() => {});
      setRemindersOn(reminderPref());
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
      if (tab !== "discover" || open || picking || privacyOpen || suggesting) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
      const decision = KEYS[e.key];
      if (decision) stack.current?.fling(decision);
      else if (e.key === "ArrowUp" && top) openDetails(top, "button");
      else return;
      e.preventDefault();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  });

  // one card at a time at the top of Discover: the consent question first, then reminders, then installing
  let prompt: ReactNode = null;
  if (city && sharing === null) {
    prompt = <ConsentBanner onAnswer={answerConsent} onReadMore={() => setPrivacyOpen(true)} />;
  } else if (city && remindersOn === null && support === "yes" && canRemind && ahead.some(remindable)) {
    prompt = <RemindersPrompt onYes={() => void reminders(true)} onNo={() => { declineReminders(); setRemindersOn("off"); }} />;
  } else if (city && installWay && !installOff
    && (ahead.length >= 3 || (installWay === "ios" && canRemind && ahead.some(remindable)))) {
    prompt = <InstallPrompt way={installWay} onYes={() => void install(true)} onNo={() => void install(false)} />;
  }

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
    body = <NoEvents onReload={load} onSuggest={() => setSuggesting({ link: "" })} />;
  } else if (top) {
    body = <CardStack ref={stack} events={visible.slice(0, 3)} onDecide={decide} onOpen={openDetails} />;
  } else {
    body = (
      <EmptyState
        category={category}
        hasSaved={savedEvents.length > 0}
        onBrowseAll={category !== ALL && queue.length > 0 ? () => setCategory(ALL) : undefined}
        onRestart={Object.values(store.states).some((s) => s !== "saved") ? () => dispatch({ type: "restart" }) : undefined}
        onSuggest={() => setSuggesting({ link: "" })}
      />
    );
  }

  return (
    <main className="app">
      {tab === "discover" ? (
        <div className="screen">
          <header className="header">
            <div className="header-title">
              <Brand />
              <div>
                <h1>
                  <button type="button" className="city-btn" aria-haspopup="dialog" onClick={() => setPicking(true)}>
                    {city ? cityName(city) : "Pick a city"} <IconChevronDown size={22} weight={2.5} />
                  </button>
                </h1>
                <p className="subtitle">{!city ? "" : events ? `This month · ${queue.length} events to go` : "Loading…"}</p>
              </div>
            </div>
            <div className="header-actions">
              <button type="button" className="icon-btn" aria-label="Suggest an event" aria-haspopup="dialog"
                onClick={() => setSuggesting({ link: "" })} disabled={!city}><IconPlus /></button>
              <button type="button" className="icon-btn" aria-label="Reload events" onClick={load} disabled={!city}><IconRefresh /></button>
            </div>
          </header>
          {prompt}
          {ready && !prompt && (
            <div className="ready-banner" role="status">
              <span>Events for {ready.name} are ready.</span>
              <button type="button" className="bar-btn primary" onClick={() => pickCity(ready.slug)}>Switch</button>
              <button type="button" className="icon-btn" aria-label="Dismiss" onClick={() => dismissReady(ready.slug)}>
                <IconX />
              </button>
            </div>
          )}
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
            <ActionButton label="Save" big tone="save" onClick={() => stack.current?.fling("save")} disabled={noCards}><IconBookmark size={26} weight={2.25} /></ActionButton>
            <ActionButton label="Later" tone="later" onClick={() => stack.current?.fling("later")} disabled={noCards}><IconClock /></ActionButton>
          </div>
        </div>
      ) : (
        <Saved
          events={savedEvents}
          going={store.going}
          answers={store.answers}
          sharing={sharing === "yes"}
          reminders={{ on: remindersOn === "on", support, available: canRemind }}
          onOpen={(e) => openDetails(e, "list")}
          onRemove={unsave}
          onAnswer={answer}
          onRate={rate}
          onRemindersChange={(on) => void reminders(on)}
          onSharingChange={answerConsent}
          onPrivacy={() => setPrivacyOpen(true)}
          onDownloadData={downloadData}
          onDeleteData={deleteData}
        />
      )}

      {tab === "saved" && toast && <p className="toast" role="status">{toast}</p>}

      <nav className="tabbar" aria-label="Sections">
        <button type="button" className="tab" aria-current={tab === "discover" ? "page" : undefined} onClick={() => setTab("discover")}>
          <IconCompass size={22} /><span>Discover</span>
        </button>
        <button type="button" className="tab" aria-current={tab === "saved" ? "page" : undefined} onClick={() => setTab("saved")}>
          <IconBookmark size={22} /><span>Saved · {ahead.length}</span>
        </button>
      </nav>

      {picking && !privacyOpen && (
        <CityPicker
          cities={cities}
          current={city}
          firstRun={!city}
          onPick={pickCity}
          onClose={() => setPicking(false)}
          onRequested={(slug, name) => { rememberRequest({ slug, name }); setRequested(requestedCities()); }}
        />
      )}

      {open && (
        <Details
          event={open}
          state={store.states[open.id]}
          going={Boolean(store.going[open.id])}
          onGoing={(on) => setGoing(open, on)}
          onClose={() => setOpen(null)}
          onDecide={(d) => { decide(open, d, "button"); setOpen(null); }}
          onUnsave={() => { unsave(open); setOpen(null); }}
          onTrack={(action: Action) => track(action, open.id, { via: "button" })}
        />
      )}

      {suggesting && city && !picking && !privacyOpen && (
        <SuggestSheet cities={cities} city={city} link={suggesting.link} onOpenEvent={openSuggested}
          onClose={() => setSuggesting(null)} />
      )}

      {privacyOpen && <PrivacyNotice onClose={closePrivacy} />}
    </main>
  );
}

/** The server has no events at all (as opposed to: you've swiped through them). */
function NoEvents({ onReload, onSuggest }: { onReload(): void; onSuggest(): void }) {
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
        <SuggestLink onClick={onSuggest} />
        <Mascot />
      </div>
    </div>
  );
}

/** You've swiped through everything (in this category). */
function EmptyState({ category, hasSaved, onBrowseAll, onRestart, onSuggest }: {
  category: string; hasSaved: boolean; onBrowseAll?: () => void; onRestart?: () => void; onSuggest(): void;
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
        <SuggestLink onClick={onSuggest} />
        <Mascot />
      </div>
    </div>
  );
}

function SuggestLink({ onClick }: { onClick(): void }) {
  return (
    <button type="button" className="text-btn plain suggest-link" aria-haspopup="dialog" onClick={onClick}>
      Know of something that isn’t here? Suggest it
    </button>
  );
}

function ActionButton({ label, big, tone, disabled, onClick, children }: {
  label: string; big?: boolean; tone?: "save" | "later"; disabled?: boolean;
  onClick(): void; children: ReactNode;
}) {
  return (
    <div className={["action", big && "big", tone].filter(Boolean).join(" ")}>
      <button type="button" aria-label={label} disabled={disabled} onClick={onClick}>{children}</button>
      <span aria-hidden="true">{label}</span>
    </div>
  );
}
