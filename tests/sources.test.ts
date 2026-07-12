import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchLinearItems } from "../lib/linear";
import { fetchAttioItems } from "../lib/attio";

// The source modules read env lazily, so plain assignments here are enough.
process.env.LINEAR_API_KEY = "lin_test";
process.env.LINEAR_TEAM_IDS = "team-1";
process.env.LINEAR_TASKLIST = "Dev";
process.env.ATTIO_API_KEY = "attio_test";
process.env.ATTIO_ASSIGNEE = "me@example.com";
process.env.ATTIO_WORKSPACE_SLUG = "acme";
process.env.ATTIO_TASKLIST = "Sales";
process.env.SYNC_LOOKBACK_DAYS = "14";

type Router = (url: string, init?: RequestInit) => { status?: number; body: unknown } | undefined;

/** Swap global fetch for a router during `fn`, always restoring it after. */
async function withFetch(router: Router, fn: () => Promise<void>) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = String(input);
    const match = router(url, init);
    if (!match) throw new Error(`Unexpected fetch in test: ${url}`);
    return new Response(JSON.stringify(match.body), {
      status: match.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
}

// ── Linear ────────────────────────────────────────────────────────────────

function linearIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: "issue-1",
    identifier: "CORE-1",
    title: "Ship it",
    description: "Some description",
    url: "https://linear.app/acme/issue/CORE-1",
    dueDate: "2026-07-20",
    priorityLabel: "High",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-02T00:00:00.000Z",
    completedAt: null,
    canceledAt: null,
    state: { name: "In Progress", type: "started" },
    assignee: { name: "Jane Doe", email: "jane@example.com" },
    project: { name: "Q3" },
    cycle: null,
    parent: null,
    labels: { nodes: [{ name: "bug" }] },
    ...overrides,
  };
}

test("fetchLinearItems paginates and normalizes issues", async () => {
  await withFetch(
    (url, init) => {
      if (!url.includes("api.linear.app")) return undefined;
      const variables = JSON.parse(String(init?.body)).variables as { after: string | null };
      const page1 = variables.after === null;
      return {
        body: {
          data: {
            team: {
              issues: {
                nodes: page1
                  ? [linearIssue()]
                  : [
                      linearIssue({
                        id: "issue-2",
                        identifier: "CORE-2",
                        title: "Dupe",
                        dueDate: null,
                        canceledAt: "2026-07-10T00:00:00.000Z",
                        state: { name: "Duplicate", type: "duplicate" },
                      }),
                    ],
                pageInfo: { hasNextPage: page1, endCursor: page1 ? "cursor-1" : null },
              },
            },
          },
        },
      };
    },
    async () => {
      const items = await fetchLinearItems();
      assert.equal(items.length, 2);

      const [first, second] = items;
      assert.equal(first.key, "linear:issue-1");
      assert.equal(first.title, "CORE-1: Ship it");
      assert.equal(first.list, "Dev");
      assert.equal(first.done, false);
      assert.equal(first.due, "2026-07-20T00:00:00.000Z");
      const notes = first.extraNotes?.join("\n") ?? "";
      assert.ok(notes.includes("Status: In Progress"));
      assert.ok(notes.includes("Assignee: Jane Doe (jane@example.com)"));
      assert.ok(notes.includes("Labels: bug"));
      assert.ok(notes.includes("Some description"));

      // Duplicate-state issues must close the Google task, not stay actionable.
      assert.equal(second.done, true);
      assert.equal(second.due, null);
    },
  );
});

test("fetchLinearItems honors LINEAR_STATE_TYPES in the issue filter", async () => {
  process.env.LINEAR_STATE_TYPES = "unstarted, started, backlog";
  try {
    let capturedFilter: any;
    await withFetch(
      (_url, init) => {
        capturedFilter = JSON.parse(String(init?.body)).variables.filter;
        return {
          body: { data: { team: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } },
        };
      },
      async () => {
        await fetchLinearItems();
        assert.deepEqual(capturedFilter.or[0].state.type.in, ["unstarted", "started", "backlog"]);
      },
    );
  } finally {
    delete process.env.LINEAR_STATE_TYPES;
  }
});

test("fetchLinearItems fails clearly on an unknown team id", async () => {
  await withFetch(
    () => ({ body: { data: { team: null } } }),
    async () => {
      await assert.rejects(fetchLinearItems, /LINEAR_TEAM_IDS/);
    },
  );
});

// ── Attio ─────────────────────────────────────────────────────────────────

function attioTask(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id: { workspace_id: "ws", task_id: id },
    content_plaintext: `Task ${id}`,
    deadline_at: null,
    is_completed: false,
    completed_at: null,
    linked_records: [],
    assignees: [],
    created_by_actor: { type: "workspace-member", id: null },
    created_at: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

test("fetchAttioItems paginates, enriches, and tolerates missing data", async () => {
  const now = Date.now();
  const fullTask = attioTask("task-full", {
    content_plaintext: "Call John\nwith agenda",
    deadline_at: "2026-07-25T09:00:00.000Z",
    linked_records: [{ target_object_id: "obj-people", target_record_id: "rec-1" }],
    assignees: [{ referenced_actor_type: "workspace-member", referenced_actor_id: "member-1" }],
    created_by_actor: { type: "workspace-member", id: "member-1" },
  });
  // Fields entirely absent — the enrichment must not crash on these.
  const bareTask = {
    id: { workspace_id: "ws", task_id: "task-bare" },
    content_plaintext: null,
    deadline_at: null,
    is_completed: false,
    completed_at: null,
    created_at: "2026-07-01T00:00:00.000Z",
  };
  const brokenLinkTask = attioTask("task-broken", {
    linked_records: [{ target_object_id: "obj-people", target_record_id: "rec-deleted" }],
  });

  await withFetch(
    (url) => {
      if (!url.includes("api.attio.com")) return undefined;
      const parsed = new URL(url);
      if (parsed.pathname === "/v2/tasks") {
        const offset = Number(parsed.searchParams.get("offset"));
        if (parsed.searchParams.get("is_completed") === "false") {
          // Two pages: a full first page proves the pagination loop continues.
          const page0 = Array.from({ length: 500 }, (_, i) => attioTask(`task-open-${i}`));
          return { body: { data: offset === 0 ? page0 : [fullTask, bareTask, brokenLinkTask] } };
        }
        const recent = attioTask("task-done", {
          is_completed: true,
          completed_at: new Date(now - 24 * 60 * 60 * 1000).toISOString(),
        });
        const stale = attioTask("task-old", {
          is_completed: true,
          completed_at: new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString(),
        });
        return { body: { data: offset === 0 ? [recent, stale] : [] } };
      }
      if (parsed.pathname === "/v2/workspace_members") {
        return {
          body: {
            data: [
              {
                id: { workspace_member_id: "member-1" },
                first_name: "Jane",
                last_name: "Doe",
                email_address: "jane@example.com",
              },
            ],
          },
        };
      }
      if (parsed.pathname === "/v2/objects/obj-people") {
        return { body: { data: { api_slug: "people", singular_noun: "Person" } } };
      }
      if (parsed.pathname === "/v2/objects/people/records/rec-1") {
        return {
          body: {
            data: {
              web_url: "https://app.attio.com/acme/person/rec-1",
              values: {
                name: [{ full_name: "John Client" }],
                email_addresses: [{ email_address: "john@client.com" }],
              },
            },
          },
        };
      }
      if (parsed.pathname === "/v2/objects/people/records/rec-deleted") {
        return { status: 404, body: { error: "not found" } };
      }
      return undefined;
    },
    async () => {
      const items = await fetchAttioItems();
      // 500 + 3 open, plus 1 recently-completed; the stale completion is dropped.
      assert.equal(items.length, 504);
      assert.ok(!items.some((i) => i.key === "attio:task-old"));

      const full = items.find((i) => i.key === "attio:task-full");
      assert.ok(full);
      assert.equal(full.title, "Call John");
      assert.equal(full.list, "Sales");
      assert.equal(full.due, "2026-07-25T09:00:00.000Z");
      assert.deepEqual(full.links, [{ label: "Attio task", url: "https://app.attio.com/acme/tasks" }]);
      const notes = full.extraNotes?.join("\n") ?? "";
      assert.ok(notes.includes("Assignee: Jane Doe (jane@example.com)"));
      assert.ok(notes.includes("Created by: Jane Doe (jane@example.com)"));
      assert.ok(notes.includes("Person: John Client"));
      assert.ok(notes.includes("Attio record: https://app.attio.com/acme/person/rec-1"));
      assert.ok(notes.includes("Details: john@client.com"));
      assert.ok(notes.includes("Call John\nwith agenda"));

      const bare = items.find((i) => i.key === "attio:task-bare");
      assert.ok(bare);
      assert.equal(bare.title, "(untitled Attio task)");

      // The deleted linked record is skipped; the task itself still syncs.
      const broken = items.find((i) => i.key === "attio:task-broken");
      assert.ok(broken);
      assert.ok(!broken.extraNotes?.includes("Related records"));

      const done = items.find((i) => i.key === "attio:task-done");
      assert.equal(done?.done, true);
    },
  );
});
