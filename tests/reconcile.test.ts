import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcile } from "../lib/reconcile";
import { GoogleApiError, type GoogleTasksClient } from "../lib/google";
import type { SyncStore, SyncRecord } from "../lib/store";
import type { SourceItem } from "../lib/types";

/** In-memory stand-in for the Redis-backed SyncStore. */
function fakeStore(initial: Record<string, SyncRecord> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    all: async () => new Map(map),
    set: async (key: string, record: SyncRecord) => void map.set(key, record),
    delete: async (key: string) => void map.delete(key),
  };
}

/** Call-recording stand-in for GoogleTasksClient. */
function fakeGoogle(overrides: Partial<Record<"insert" | "patch" | "complete", unknown>> = {}) {
  const calls: { method: string; args: unknown[] }[] = [];
  let nextId = 1;
  const record =
    (method: string, impl: (...args: any[]) => any) =>
    async (...args: any[]) => {
      calls.push({ method, args });
      const override = overrides[method as keyof typeof overrides];
      if (override instanceof Error) throw override;
      return impl(...args);
    };
  return {
    calls,
    resolveList: record("resolveList", (title: string) => `list:${title}`),
    insert: record("insert", () => ({ id: `gtask-${nextId++}` })),
    patch: record("patch", () => ({})),
    complete: record("complete", () => ({})),
  };
}

const asGoogle = (g: unknown) => g as GoogleTasksClient;
const asStore = (s: unknown) => s as SyncStore;

function item(overrides: Partial<SourceItem> = {}): SourceItem {
  return {
    key: "linear:abc",
    title: "CORE-1: Do the thing",
    list: "Dev",
    identifier: "CORE-1",
    done: false,
    due: null,
    links: [{ label: "Linear issue", url: "https://linear.app/x/issue/CORE-1" }],
    ...overrides,
  };
}

test("creates a Google task for a new open item and saves the mapping", async () => {
  const google = fakeGoogle();
  const store = fakeStore();

  const result = await reconcile([item()], asGoogle(google), asStore(store));

  assert.equal(result.created, 1);
  const insert = google.calls.find((c) => c.method === "insert");
  assert.ok(insert);
  assert.equal((insert.args[1] as { title: string }).title, "CORE-1: Do the thing");
  const saved = store.map.get("linear:abc");
  assert.ok(saved);
  assert.equal(saved.googleTaskId, "gtask-1");
  assert.equal(saved.tasklistId, "list:Dev");
  assert.equal(saved.done, false);
});

test("skips items that are already done and were never synced", async () => {
  const google = fakeGoogle();
  const store = fakeStore();

  const result = await reconcile([item({ done: true })], asGoogle(google), asStore(store));

  assert.equal(result.skipped, 1);
  assert.equal(result.created, 0);
  assert.equal(google.calls.length, 0);
});

test("completes the Google task when a mapped item becomes done", async () => {
  const google = fakeGoogle();
  const store = fakeStore({
    "linear:abc": { googleTaskId: "g1", tasklistId: "l1", done: false, hash: "h", updatedAt: "t" },
  });

  const result = await reconcile([item({ done: true })], asGoogle(google), asStore(store));

  assert.equal(result.completed, 1);
  assert.deepEqual(google.calls, [{ method: "complete", args: ["l1", "g1"] }]);
  assert.equal(store.map.get("linear:abc")?.done, true);
});

test("skips a mapped open item whose content is unchanged", async () => {
  const google = fakeGoogle();
  const store = fakeStore();
  // First pass creates and stores the content hash…
  await reconcile([item()], asGoogle(google), asStore(store));
  google.calls.length = 0;

  // …second pass with identical content is a no-op.
  const result = await reconcile([item()], asGoogle(google), asStore(store));
  assert.equal(result.skipped, 1);
  assert.equal(google.calls.length, 0);
});

test("patches the Google task when content changes, sending null to clear a removed due date", async () => {
  const google = fakeGoogle();
  const store = fakeStore();
  await reconcile([item({ due: "2026-07-01T00:00:00.000Z" })], asGoogle(google), asStore(store));
  google.calls.length = 0;

  const result = await reconcile(
    [item({ title: "CORE-1: Do the thing (renamed)", due: null })],
    asGoogle(google),
    asStore(store),
  );

  assert.equal(result.updated, 1);
  const patch = google.calls.find((c) => c.method === "patch");
  assert.ok(patch);
  const fields = patch.args[2] as { due: string | null };
  // Must be an explicit null so JSON.stringify keeps it and Google clears the date.
  assert.equal(fields.due, null);
  assert.ok(JSON.stringify(fields).includes('"due":null'));
});

test("heals a hand-deleted Google task: drops the mapping on complete, recreates on update", async () => {
  const gone = new GoogleApiError("gone", 404);

  const completeStore = fakeStore({
    "linear:abc": { googleTaskId: "g1", tasklistId: "l1", done: false, hash: "h", updatedAt: "t" },
  });
  const completeResult = await reconcile(
    [item({ done: true })],
    asGoogle(fakeGoogle({ complete: gone })),
    asStore(completeStore),
  );
  assert.equal(completeResult.healed, 1);
  assert.equal(completeStore.map.has("linear:abc"), false);

  const updateStore = fakeStore({
    "linear:abc": { googleTaskId: "g1", tasklistId: "l1", done: false, hash: "stale", updatedAt: "t" },
  });
  const updateGoogle = fakeGoogle({ patch: gone });
  const updateResult = await reconcile([item()], asGoogle(updateGoogle), asStore(updateStore));
  assert.equal(updateResult.healed, 1);
  assert.ok(updateGoogle.calls.some((c) => c.method === "insert"));
  assert.equal(updateStore.map.get("linear:abc")?.googleTaskId, "gtask-1");
});

test("non-404 Google errors propagate instead of being swallowed", async () => {
  const store = fakeStore({
    "linear:abc": { googleTaskId: "g1", tasklistId: "l1", done: false, hash: "stale", updatedAt: "t" },
  });
  const google = fakeGoogle({ patch: new GoogleApiError("quota", 429) });
  await assert.rejects(() => reconcile([item()], asGoogle(google), asStore(store)), /quota/);
});

test("dry run reports a plan and performs no writes", async () => {
  const google = fakeGoogle();
  const store = fakeStore({
    "linear:done-me": { googleTaskId: "g1", tasklistId: "l1", done: false, hash: "h", updatedAt: "t" },
  });

  const result = await reconcile(
    [item(), item({ key: "linear:done-me", done: true })],
    null,
    asStore(store),
    { dryRun: true },
  );

  assert.equal(result.created, 1);
  assert.equal(result.completed, 1);
  assert.deepEqual(
    result.plan?.map((p) => p.action),
    ["create", "complete"],
  );
  assert.equal(google.calls.length, 0);
  assert.equal(store.map.get("linear:done-me")?.done, false);
});

test("truncates oversized notes below the Google Tasks limit", async () => {
  const google = fakeGoogle();
  const store = fakeStore();

  await reconcile(
    [item({ extraNotes: ["x".repeat(10_000)] })],
    asGoogle(google),
    asStore(store),
  );

  const insert = google.calls.find((c) => c.method === "insert");
  const notes = (insert?.args[1] as { notes: string }).notes;
  assert.ok(notes.length <= 7900);
  assert.ok(notes.endsWith("[Description truncated]"));
});
