// The rollout's numbers (see the rollout plan), from the database:  npm run metrics [-- --weeks 8]
// Everything but the consent rate counts only people who share their activity.
import { closeDb, getDb } from "../netlify/lib/db.mts";
import type { EventDoc, InteractionDoc, StateDoc } from "../netlify/lib/models.mts";
import type { ReminderDoc } from "../netlify/lib/reminders.mts";
import type { StatsDoc } from "../netlify/lib/stats.mts";

const DAY = 86_400_000;
const weeksArg = process.argv.indexOf("--weeks");
const WEEKS = weeksArg > 0 ? Number(process.argv[weeksArg + 1]) || 8 : 8;
const now = Date.now();
const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : "–");
/** Monday of the week, "2026-12-07". */
const weekOf = (t: number) => {
  const d = new Date(t);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
};

const db = await getDb();
try {
  // where each event is (events, or the stats kept after an event is deleted)
  const cityOf = new Map<string, string>();
  for (const s of await db.collection<StatsDoc>("eventStats").find({}, { projection: { city: 1 } }).toArray()) cityOf.set(s._id, s.city);
  const events = await db.collection<EventDoc>("events").find({}, { projection: { city: 1, visibleUntil: 1 } }).toArray();
  for (const e of events) cityOf.set(e._id, e.city ?? "winnipeg");
  const ended = new Set(events.filter((e) => e.visibleUntil.getTime() < now).map((e) => e._id));

  interface Device { first: number; days: Set<number>; city: string; saves: number; going: boolean; answered: Set<string> }
  const devices = new Map<string, Device>();
  const weekly = new Map<string, { people: Set<string>; saves: number; views: number; tickets: number }>();
  let reminderTaps = 0;
  const cursor = db.collection<InteractionDoc>("interactions")
    .find({}, { projection: { deviceId: 1, eventId: 1, action: 1, at: 1, "context.via": 1 } }).sort({ at: 1 });
  for await (const i of cursor) {
    const t = i.at.getTime();
    const d = devices.get(i.deviceId) ?? { first: t, days: new Set(), city: cityOf.get(i.eventId) ?? "?", saves: 0, going: false, answered: new Set() };
    devices.set(i.deviceId, d);
    d.days.add(Math.floor((t - d.first) / DAY));
    if (i.action === "save") d.saves++;
    if (i.action === "going") d.going = true;
    if (i.action === "attended") d.answered.add(i.eventId);
    if (i.action === "details" && i.context?.via === "reminder") reminderTaps++;
    const w = weekly.get(weekOf(t)) ?? { people: new Set(), saves: 0, views: 0, tickets: 0 };
    weekly.set(weekOf(t), w);
    w.people.add(i.deviceId);
    if (i.action === "save") w.saves++;
    if (i.action === "view") w.views++;
    if (i.action === "tickets") w.tickets++;
  }

  const tallies = await db.collection<{ _id: string; [k: string]: number | string }>("tallies").find().toArray();
  const sum = (k: string) => tallies.reduce((n, t) => n + (Number(t[k]) || 0), 0);

  console.log("\nCONSENT (anonymous tally)");
  console.log(`  Allow ${sum("consent_yes")}, No thanks ${sum("consent_no")}: ${pct(sum("consent_yes"), sum("consent_yes") + sum("consent_no"))} allow`);

  console.log("\nRETURN, by the week people first used the app");
  const cohorts = new Map<string, Device[]>();
  for (const d of devices.values()) cohorts.set(weekOf(d.first), [...(cohorts.get(weekOf(d.first)) ?? []), d]);
  const back = (list: Device[], from: number, to: number) => {
    const eligible = list.filter((d) => now - d.first >= (to + 1) * DAY);
    return [eligible.filter((d) => [...d.days].some((n) => n >= from && n <= to)).length, eligible.length] as const;
  };
  console.table([...cohorts].sort().slice(-WEEKS).map(([week, list]) => {
    const [w2, w2of] = back(list, 7, 13), [w5, w5of] = back(list, 28, 34);
    return { week, "new people": list.length, "week-2 return": `${pct(w2, w2of)} of ${w2of}`, "week-5 return": `${pct(w5, w5of)} of ${w5of}` };
  }));

  console.log("WEEKLY ACTIVITY");
  console.table([...weekly].sort().slice(-WEEKS).map(([week, w]) => ({
    week, "active people": w.people.size, "saves per person": w.people.size ? (w.saves / w.people.size).toFixed(1) : "–",
    "ticket taps per 100 views": w.views ? ((100 * w.tickets) / w.views).toFixed(1) : "–",
  })));

  console.log("ACTIVE PEOPLE BY CITY (last 7 days)");
  const recent = new Map<string, number>();
  for (const d of devices.values()) if ([...d.days].some((n) => d.first + n * DAY >= now - 7 * DAY)) recent.set(d.city, (recent.get(d.city) ?? 0) + 1);
  console.table(Object.fromEntries([...recent].sort((a, b) => b[1] - a[1])));

  const savers = [...devices.values()].filter((d) => d.saves > 0);
  const states = await db.collection<StateDoc>("userEventState").find({ state: "saved", "_id.e": { $in: [...ended] } }, { projection: { _id: 1 } }).toArray();
  const asked = states.length;
  const answered = states.filter((s) => devices.get(s._id.u)?.answered.has(s._id.e)).length;
  const subscribed = await db.collection<ReminderDoc>("reminders").countDocuments();
  console.log("FEATURES (people who share their activity)");
  console.table({
    "Going: savers who marked one": `${pct(savers.filter((d) => d.going).length, savers.length)} of ${savers.length}`,
    "Did you go?: answered / ended saved events": `${pct(answered, asked)} of ${asked}`,
    "Reminders on: devices / savers": `${subscribed} / ${savers.length}`,
    "Reminder taps / reminders sent": `${reminderTaps} / ${sum("reminders_sent")} (${pct(reminderTaps, sum("reminders_sent"))})`,
    "Installs (tally) / people with 3+ saves": `${sum("installed")} / ${savers.filter((d) => d.saves >= 3).length}`,
  });

  // "Suggest an event", whether people share their activity or not: links (not devices) by city and where they stand
  console.log("SUGGESTED EVENTS: links by city (review them: python3 crawler/suggestions.py list)");
  const suggested = await db.collection("suggestions").aggregate([
    // a link counts as added if it was, else new if anyone's is still waiting
    { $group: { _id: { city: "$city", key: "$key" }, rank: { $max: { $indexOfArray: [["rejected", "new", "added"], "$status"] } }, last: { $max: "$at" } } },
    { $group: { _id: "$_id.city", rejected: { $sum: { $cond: [{ $eq: ["$rank", 0] }, 1, 0] } },
      new: { $sum: { $cond: [{ $eq: ["$rank", 1] }, 1, 0] } }, added: { $sum: { $cond: [{ $eq: ["$rank", 2] }, 1, 0] } },
      last: { $max: "$last" } } },
    { $sort: { _id: 1 } },
  ]).toArray();
  if (suggested.length) {
    console.table(suggested.map((x) => ({ city: x._id, new: x.new, added: x.added, rejected: x.rejected, latest: x.last?.toISOString().slice(0, 10) })));
  } else {
    console.log("  none yet\n");
  }

  console.log("CRAWLS: each city's latest run (runs from before cities are Winnipeg's)");
  const runs = await db.collection("runs").aggregate([{ $sort: { startedAt: -1 } }, { $group: { _id: { $ifNull: ["$city", "winnipeg"] }, status: { $first: "$status" }, total: { $first: "$total" }, at: { $first: "$startedAt" } } }, { $sort: { _id: 1 } }]).toArray();
  console.table(runs.map((r) => ({ city: r._id, status: r.status, events: r.total, when: r.at?.toISOString().slice(0, 16) })));
} finally {
  await closeDb();
}
