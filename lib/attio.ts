import { env } from "./env";
import type { SourceItem } from "./types";

const API_BASE = "https://api.attio.com/v2";

interface AttioTask {
  id: { workspace_id: string; task_id: string };
  content_plaintext: string;
  deadline_at: string | null;
  is_completed: boolean;
  completed_at: string | null;
  linked_records: { target_object_id: string; target_record_id: string }[];
}

async function listTasks(query: Record<string, string>): Promise<AttioTask[]> {
  const params = new URLSearchParams({ limit: "500", ...query });
  const res = await fetch(`${API_BASE}/tasks?${params}`, {
    headers: {
      Authorization: `Bearer ${env.attioApiKey()}`,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(`Attio API request failed (${res.status}): ${await res.text()}`);
  }
  const json = (await res.json()) as { data: AttioTask[] };
  return json.data ?? [];
}

function toSourceItem(task: AttioTask): SourceItem {
  const slug = env.attioWorkspaceSlug();
  const firstLine = (task.content_plaintext || "(untitled Attio task)").split("\n")[0].trim();
  const title = firstLine.length > 250 ? `${firstLine.slice(0, 247)}...` : firstLine;

  const links: { label: string; url: string }[] = [];
  if (slug) links.push({ label: "Attio task", url: `https://app.attio.com/${slug}/tasks` });

  const extraNotes = [`Attio task id: ${task.id.task_id}`];
  const linked = task.linked_records?.[0];
  if (linked) extraNotes.push(`Linked record: ${linked.target_record_id}`);

  return {
    key: `attio:${task.id.task_id}`,
    title,
    list: env.attioTasklist(),
    identifier: null,
    done: task.is_completed,
    due: task.deadline_at,
    links,
    extraNotes,
  };
}

/**
 * Fetch tasks assigned to the configured user: all open tasks, plus tasks
 * completed within the lookback window (so completion propagates to Google).
 */
export async function fetchAttioItems(): Promise<SourceItem[]> {
  const assignee = env.attioAssignee();
  const sinceMs = Date.now() - env.lookbackDays() * 24 * 60 * 60 * 1000;

  const [open, completed] = await Promise.all([
    listTasks({ assignee, is_completed: "false", sort: "created_at:desc" }),
    listTasks({ assignee, is_completed: "true", sort: "completed_at:desc" }),
  ]);

  const recentlyCompleted = completed.filter(
    (t) => t.completed_at && new Date(t.completed_at).getTime() >= sinceMs,
  );

  return [...open, ...recentlyCompleted].map(toSourceItem);
}
