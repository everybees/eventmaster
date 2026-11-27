// Runs a scheduled function's work once, against MONGODB_URI (Netlify runs them on a schedule in production):
//   npm run job:stats       recompute event popularity (netlify/functions/event-stats.mts, hourly)
//   npm run job:reminders   send the reminders due now (netlify/functions/send-reminders.mts, every 15 minutes)
import { closeDb, getDb } from "../netlify/lib/db.mts";
import { sendReminders, webPushSender } from "../netlify/lib/reminders.mts";
import { computeStats } from "../netlify/lib/stats.mts";

const job = process.argv[2];
const db = await getDb();
try {
  if (job === "stats") {
    console.log(await computeStats(db));
  } else if (job === "reminders") {
    const send = webPushSender();
    if (!send) throw new Error("Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY (npx web-push generate-vapid-keys)");
    console.log(await sendReminders(db, send));
  } else {
    throw new Error("Usage: node scripts/jobs.mts stats|reminders");
  }
} finally {
  await closeDb();
}
