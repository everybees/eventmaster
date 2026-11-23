import { MongoClient, type Db } from "mongodb";

let client: MongoClient | undefined;
let db: Promise<Db> | undefined;

/** One connection per function instance, reused for as long as Netlify keeps the instance warm. */
export function getDb(): Promise<Db> {
  if (!db) {
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error("MONGODB_URI is not set");
    // fail in 5 s rather than the driver's 30: a function times out long before that anyway
    client = new MongoClient(uri, { maxPoolSize: 5, serverSelectionTimeoutMS: 5000, appName: "wpg-events-api" });
    db = client.connect().then((c) => c.db(process.env.MONGODB_DB || "wpg_events"));
    db.catch(() => {
      // let the next request try again instead of reusing a failed connection
      db = undefined;
      client = undefined;
    });
  }
  return db;
}

/** For tests and scripts. */
export async function closeDb(): Promise<void> {
  const c = client;
  client = undefined;
  db = undefined;
  await c?.close();
}
