import { createHash } from "node:crypto";
import { GoogleTasksClient, GoogleApiError } from "./google";
import { SyncStore } from "./store";
import type { SourceItem } from "./types";

/** Notes contain only what you want to see: identifier + links to the source. */
function buildNotes(item: SourceItem): string {
  const lines: string[] = [];
  for (const link of item.links) lines.push(`${link.label}: ${link.url}`);
  if (item.extraNotes) lines.push(...item.extraNotes);
  return lines.join("\n");
}

function contentHash(title: string, notes: string, due: string): string {
  return createHash("md5").update(`${title}\n${notes}\n${due}`).digest("hex");
}

export interface SyncResult {
  created: number;
  completed: number;
  updated: number;
  skipped: number;
  /** Google task was gone (deleted by hand); we recreated or dropped it. */
  healed: number;
}

export async function reconcile(
  items: SourceItem[],
  google: GoogleTasksClient,
  store: SyncStore,
): Promise<SyncResult> {
  const existing = await store.all();
  const result: SyncResult = { created: 0, completed: 0, updated: 0, skipped: 0, healed: 0 };

  const now = () => new Date().toISOString();

  const create = async (item: SourceItem, notes: string, hash: string) => {
    const task = await google.insert({
      title: item.title,
      notes,
      due: item.due ?? undefined,
    });
    await store.set(item.key, { googleTaskId: task.id, done: false, hash, updatedAt: now() });
  };

  for (const item of items) {
    const notes = buildNotes(item);
    const hash = contentHash(item.title, notes, item.due ?? "");
    const record = existing.get(item.key);

    // ── Never seen before ────────────────────────────────────────────────
    if (!record) {
      if (item.done) {
        result.skipped++; // don't create tasks that are already done
        continue;
      }
      await create(item, notes, hash);
      result.created++;
      continue;
    }

    // ── Source item is now done → complete the Google task ────────────────
    if (item.done) {
      if (record.done) {
        result.skipped++;
        continue;
      }
      try {
        await google.complete(record.googleTaskId);
        await store.set(item.key, { ...record, done: true, updatedAt: now() });
        result.completed++;
      } catch (err) {
        if (err instanceof GoogleApiError && err.status === 404) {
          await store.delete(item.key); // task was deleted; nothing to complete
          result.healed++;
        } else {
          throw err;
        }
      }
      continue;
    }

    // ── Source item still open → sync title/notes/due if changed ──────────
    if (record.hash === hash) {
      result.skipped++;
      continue;
    }
    try {
      await google.patch(record.googleTaskId, {
        title: item.title,
        notes,
        due: item.due ?? undefined,
      });
      await store.set(item.key, { ...record, hash, done: false, updatedAt: now() });
      result.updated++;
    } catch (err) {
      if (err instanceof GoogleApiError && err.status === 404) {
        await create(item, notes, hash); // task was deleted; recreate it
        result.healed++;
      } else {
        throw err;
      }
    }
  }

  return result;
}
