import type { ApiEvent } from "../../shared/types.ts";
import { feedKey, todayLocal } from "./format.ts";
import type { SwipeStore } from "./store.ts";

export const ALL = "All";

/** Events still to decide on, soonest first; ones sent to "later" go to the back, oldest first. */
export function remaining(events: ApiEvent[], store: SwipeStore): ApiEvent[] {
  const today = todayLocal();
  const open = events.filter((e) => store.states[e.id] !== "saved" && store.states[e.id] !== "passed");
  const fresh = open
    .filter((e) => store.states[e.id] !== "later")
    .sort((a, b) => feedKey(a, today).localeCompare(feedKey(b, today)));
  const later = open
    .filter((e) => store.states[e.id] === "later")
    .sort((a, b) => (store.laterAt[a.id] ?? 0) - (store.laterAt[b.id] ?? 0));
  return [...fresh, ...later];
}

export const inCategory = (events: ApiEvent[], category: string) =>
  category === ALL ? events : events.filter((e) => e.category === category);

export function countByCategory(events: ApiEvent[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const e of events) counts.set(e.category, (counts.get(e.category) ?? 0) + 1);
  return counts;
}
