import type { Config } from "@netlify/functions";
import { getDb } from "../lib/db.mts";
import { sendReminders, webPushSender } from "../lib/reminders.mts";

/** Every 15 minutes: sends the event reminders that are due. Does nothing until the VAPID keys are set. */
export default async (): Promise<Response> => {
  const send = webPushSender();
  if (!send) return new Response("Reminders aren't set up (VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY)");
  const result = await sendReminders(await getDb(), send);
  console.log("Reminders:", JSON.stringify(result));
  return Response.json(result);
};

export const config: Config = { schedule: "*/15 * * * *" };
