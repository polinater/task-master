import { fetchLinearItems } from "./linear";
import { fetchAttioItems } from "./attio";
import { createGoogleTasksClient } from "./google";
import { SyncStore } from "./store";
import { reconcile, type SyncResult } from "./reconcile";

export interface SyncSummary {
  dryRun: boolean;
  durationMs: number;
  fetched: { linear: number; attio: number };
  result: SyncResult;
}

/**
 * Run one full sync pass. With `dryRun: true` it fetches and computes what it
 * would do but makes no writes to Google Tasks or Redis.
 */
export async function runSync(opts: { dryRun?: boolean } = {}): Promise<SyncSummary> {
  const dryRun = opts.dryRun ?? false;
  const startedAt = Date.now();

  const [linear, attio] = await Promise.all([fetchLinearItems(), fetchAttioItems()]);
  // A dry run makes no Google calls, so don't require Google credentials for it.
  const google = dryRun ? null : await createGoogleTasksClient();
  const store = new SyncStore();
  const result = await reconcile([...linear, ...attio], google, store, { dryRun });

  const summary: SyncSummary = {
    dryRun,
    durationMs: Date.now() - startedAt,
    fetched: { linear: linear.length, attio: attio.length },
    result,
  };
  // Heartbeat: stamp the outcome so "is the cron running?" is answerable from Redis.
  if (!dryRun) await store.markRun(summary);
  return summary;
}
