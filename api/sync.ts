import { createHash, timingSafeEqual } from "node:crypto";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { env } from "../lib/env";
import { runSync } from "../lib/sync";

// Constant-time comparison; sha256 first so lengths always match.
function equalsSecret(header: string | undefined, secret: string): boolean {
  if (!header) return false;
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(header), digest(`Bearer ${secret}`));
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Guard: Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` automatically.
  // CRON_SECRET is required — without it anyone could invoke the sync.
  if (!equalsSecret(req.headers.authorization, env.cronSecret())) {
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
