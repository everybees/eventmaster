import type { Config } from "@netlify/functions";
import { TALLIES, type Tally } from "../../shared/types.ts";
import { getDb } from "../lib/db.mts";
import { error, handler } from "../lib/http.mts";
import { tally } from "../lib/tally.mts";

/**
 * POST /api/tally { "tally": "consent_yes" } — adds one to today's anonymous count. Used where a device ID
 * can't be (the answer "No thanks" to sharing activity) or isn't needed (an install).
 */
export default handler(async (req) => {
  if (req.method !== "POST") return error(405, "Use POST");
  let body: unknown;
  try {
    body = JSON.parse((await req.text()).slice(0, 200));
  } catch {
    return error(400, "Body must be JSON");
  }
  const name = (body as { tally?: unknown } | null)?.tally;
  if (!TALLIES.includes(name as Tally)) return error(400, `tally must be one of ${TALLIES.join(", ")}`);
  await tally(await getDb(), { [name as Tally]: 1 });
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
});

export const config: Config = { path: "/api/tally" };
