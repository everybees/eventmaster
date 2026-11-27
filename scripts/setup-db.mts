// Creates the MongoDB indexes. Run once per database (and again after adding an index):
//   MONGODB_URI=… npm run db:setup
// Use a user allowed to create indexes; the app and crawler users don't need that right.
import { closeDb, getDb } from "../netlify/lib/db.mts";
import { setupIndexes } from "../netlify/lib/indexes.mts";

const db = await getDb();
await setupIndexes(db);
for (const name of ["events", "interactions", "userEventState", "runs", "places", "cityRequests", "cityRequestLog", "eventStats"]) {
  const indexes = await db.collection(name).indexes();
  console.log(`${name}: ${indexes.map((i) => i.name).join(", ")}`);
}
await closeDb();
