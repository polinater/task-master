import { createHash } from "node:crypto";
import { GoogleTasksClient, GoogleApiError } from "./google";
import { SyncStore } from "./store";
import type { SourceItem } from "./types";

/** Render the notes body: source links first, then the source-specific detail lines. */
function buildNotes(item: SourceItem): string {
  const lines: string[] = [];
  for (const link of item.links) lines.push(`${link.label}: ${link.url}`);
  if (item.extraNotes) lines.push(...item.extraNotes);
  const notes = lines.join("\n");
  // Google Tasks accepts rich plain text, but keep a safety margin below its
  // notes limit. Preserve the beginning (source/status metadata) and mark cuts.
  return notes.length > 7900 ? `${notes.slice(0, 7860)}\n\n[Description truncated]` : notes;
}

function contentHash(title: string, notes: string, due: string): string {
  return createHash("sha256").update(`${title}\n${notes}\n${due}`).digest("hex");
}

export interface PlanEntry {
  action: "create" | "complete" | "update";
  list: string;
  title: string;
}

export interface SyncResult {
  created: number;
  completed: number;
  updated: number;
  skipped: number;
  /** Google task was gone (deleted by hand); we recreated or dropped it. */
  healed: number;
  /** Populated only on a dry run: the actions that would be taken. */
  plan?: PlanEntry[];
}

export async function reconcile(
  items: SourceItem[],
  google: GoogleTasksClient | null,
  store: SyncStore,
  opts: { dryRun?: boolean } = {},
): Promise<SyncResult> {
  const dryRun = opts.dryRun ?? false;
  const existing = await store.all();
  const result: SyncResult = { created: 0, completed: 0, updated: 0, skipped: 0, healed: 0 };
  const plan: PlanEntry[] = [];

  const now = () => new Date().toISOString();

  const create = async (item: SourceItem, notes: string, hash: string) => {
    const tasklistId = await google!.resolveList(item.list);
    const task = await google!.insert(tasklistId, {
      title: item.title,
      notes,
      due: item.due ?? undefined,
    });
    await store.set(item.key, {
      googleTaskId: task.id,
      tasklistId,
      done: false,
      hash,
      updatedAt: now(),
    });
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
      result.created++;
      if (dryRun) {
        plan.push({ action: "create", list: item.list, title: item.title });
        continue;
      }
      await create(item, notes, hash);
      continue;
    }

    // ── Source item is now done → complete the Google task ────────────────
    if (item.done) {
      if (record.done) {
        result.skipped++;
        continue;
      }
      if (dryRun) {
        result.completed++;
        plan.push({ action: "complete", list: item.list, title: item.title });
        continue;
      }
      try {
        await google!.complete(record.tasklistId, record.googleTaskId);
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
    if (dryRun) {
      result.updated++;
      plan.push({ action: "update", list: item.list, title: item.title });
      continue;
    }
    try {
      await google!.patch(record.tasklistId, record.googleTaskId, {
        title: item.title,
        notes,
        // null (not undefined) so a due date removed at the source is cleared;
        // undefined would be dropped from the JSON body and Google would keep it.
        due: item.due,
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

  if (dryRun) result.plan = plan;
  return result;
}
