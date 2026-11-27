import type { Db } from "mongodb";

/** Anonymous daily counters (`tallies`, one document per UTC day, e.g. { consent_yes: 12, reminders_sent: 40 }):
 *  no device ID, no IP address. */
export async function tally(db: Db, counts: Record<string, number>, now = new Date()): Promise<void> {
  await db.collection<{ _id: string }>("tallies").updateOne({ _id: now.toISOString().slice(0, 10) }, { $inc: counts }, { upsert: true });
}
