// A throwaway MongoDB for local development, no install or Docker needed:
//   npm run db:local     → mongodb://127.0.0.1:27018 (data kept in .mongo-data/ between runs)
// The first run downloads a MongoDB binary (~140 MB) into node_modules/.cache/mongodb-memory-server.
// Keep this running while you use `npm run dev:web`; the API can't answer without it.
import { mkdirSync } from "node:fs";
import { MongoMemoryServer } from "mongodb-memory-server";

const port = Number(process.env.PORT ?? 27018);
const dbPath = new URL("../.mongo-data/", import.meta.url).pathname;
mkdirSync(dbPath, { recursive: true });
const server = await MongoMemoryServer.create({ instance: { port, dbPath, storageEngine: "wiredTiger" } });
console.log(`MongoDB running at ${server.getUri()}  (Ctrl+C to stop)`);
const stop = async () => {
  await server.stop({ doCleanup: false }); // keep the data folder
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
