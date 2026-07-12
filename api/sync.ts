import type { VercelRequest, VercelResponse } from "@vercel/node";
import { env } from "../lib/env";
import { runSync } from "../lib/sync";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Guard: Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` automatically
  // when CRON_SECRET is set. Also protects manual invocations.
  const secret = env.cronSecret();
  if (secret && req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  try {
    const summary = await runSync();
    console.log("sync complete", JSON.stringify(summary));
    return res.status(200).json({ ok: true, ...summary });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("sync failed", message);
    return res.status(500).json({ ok: false, error: message });
  }
}
