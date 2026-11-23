import { useEffect, useReducer } from "react";
import type { ApiEvent, SwipeState } from "../../shared/types.ts";

const KEY = "wpg.swipes.v1";
const MAX_HISTORY = 50;

/** One decision, kept so it can be undone. */
export interface Step {
  event: ApiEvent;
  prev: SwipeState | null;
  next: SwipeState;
  prevLaterAt?: number;
}

/** Everything the person has swiped, kept on the device (the server gets a copy via interactions). */
export interface SwipeStore {
  states: Record<string, SwipeState>;
  laterAt: Record<string, number>;  // when each event was sent to the back of the queue
  saved: Record<string, ApiEvent>;  // a copy, so saved events still show after they leave the feed
  history: Step[];
}

export type StoreAction =
  | { type: "decide"; event: ApiEvent; next: SwipeState }
  | { type: "undo" }
  | { type: "unsave"; id: string }
  | { type: "restart" } // bring passed and later events back; keep saved ones
  | { type: "clear" };

const empty = (): SwipeStore => ({ states: {}, laterAt: {}, saved: {}, history: [] });

function reducer(s: SwipeStore, a: StoreAction): SwipeStore {
  switch (a.type) {
    case "decide": {
      const id = a.event.id;
      const step: Step = { event: a.event, prev: s.states[id] ?? null, next: a.next, prevLaterAt: s.laterAt[id] };
      const laterAt = { ...s.laterAt };
      if (a.next === "later") laterAt[id] = Date.now();
      const saved = { ...s.saved };
      if (a.next === "saved") saved[id] = a.event;
      else delete saved[id];
      return { states: { ...s.states, [id]: a.next }, laterAt, saved, history: [...s.history, step].slice(-MAX_HISTORY) };
    }
    case "undo": {
      const step = s.history.at(-1);
      if (!step) return s;
      const id = step.event.id;
      const states = { ...s.states };
      if (step.prev) states[id] = step.prev;
      else delete states[id];
      const laterAt = { ...s.laterAt };
      if (step.prevLaterAt !== undefined) laterAt[id] = step.prevLaterAt;
      else delete laterAt[id];
      const saved = { ...s.saved };
      if (step.prev === "saved") saved[id] = step.event;
      else delete saved[id];
      return { states, laterAt, saved, history: s.history.slice(0, -1) };
    }
    case "unsave": {
      const states = { ...s.states };
      const saved = { ...s.saved };
      delete states[a.id];
      delete saved[a.id];
      return { ...s, states, saved, history: s.history.filter((h) => h.event.id !== a.id) };
    }
    case "restart":
      return { ...s, states: Object.fromEntries(Object.entries(s.states).filter(([, v]) => v === "saved")), laterAt: {}, history: [] };
    case "clear":
      return empty();
  }
}

function load(): SwipeStore {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...empty(), ...JSON.parse(raw) } : empty();
  } catch {
    return empty();
  }
}

export function useSwipeStore() {
  const [store, dispatch] = useReducer(reducer, undefined, load);
  useEffect(() => {
    localStorage.setItem(KEY, JSON.stringify(store));
  }, [store]);
  return [store, dispatch] as const;
}
