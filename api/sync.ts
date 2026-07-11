import type { VercelRequest, VercelResponse } from "@vercel/node";
import { env } from "../lib/env";
import { fetchLinearItems } from "../lib/linear";
import { fetchAttioItems } from "../lib/attio";
import { createGoogleTasksClient } from "../lib/google";
import { SyncStore } from "../lib/store";
import { reconcile } from "../lib/reconcile";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Guard: Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` automatically
  // when CRON_SECRET is set. Also protects manual invocations.
  const secret = env.cronSecret();
  if (secret && req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  const startedAt = Date.now();
  try {
    const [linear, attio] = await Promise.all([fetchLinearItems(), fetchAttioItems()]);
    const google = await createGoogleTasksClient();
    const store = new SyncStore();
    const result = await reconcile([...linear, ...attio], google, store);

    const payload = {
      ok: true,
      durationMs: Date.now() - startedAt,
      fetched: { linear: linear.length, attio: attio.length },
      result,
    };
    console.log("sync complete", JSON.stringify(payload));
    return res.status(200).json(payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("sync failed", message);
    return res.status(500).json({ ok: false, error: message });
  }
}
