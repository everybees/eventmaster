import type { Config } from "@netlify/functions";
import { getDb } from "../lib/db.mts";
import { computeStats } from "../lib/stats.mts";

/** Hourly: recomputes each event's popularity (`eventStats`) from interactions and saved states. */
export default async (): Promise<Response> => {
  const result = await computeStats(await getDb());
  console.log("Event stats:", JSON.stringify(result));
  return Response.json(result);
};

export const config: Config = { schedule: "@hourly" };
