import { env } from "./env";
import { formatTimestamp } from "./format";
import type { SourceItem } from "./types";

const API_BASE = "https://api.attio.com/v2";

interface AttioTask {
  id: { workspace_id: string; task_id: string };
  content_plaintext: string | null;
  deadline_at: string | null;
  is_completed: boolean;
  completed_at: string | null;
  linked_records?: { target_object_id: string; target_record_id: string }[];
  assignees?: { referenced_actor_type: string; referenced_actor_id: string }[];
  created_by_actor?: { type: string; id: string | null };
  created_at: string;
}

interface AttioMember {
  id: { workspace_member_id: string };
  first_name: string;
  last_name: string;
  email_address: string;
}

interface AttioObject {
  api_slug: string;
  singular_noun: string;
}

interface AttioRecord {
  web_url: string;
  values: Record<string, unknown[]>;
}

interface LinkedContext {
  noun: string;
  name: string;
  url: string;
  details: string[];
}

async function getData<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${env.attioApiKey()}`, "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`Attio API request failed (${res.status}): ${await res.text()}`);
  return ((await res.json()) as { data: T }).data;
}

/** List tasks matching `query`, paging past Attio's 500-per-request cap. */
async function listTasks(query: Record<string, string>): Promise<AttioTask[]> {
  const limit = 500;
  const tasks: AttioTask[] = [];
  for (let offset = 0; ; offset += limit) {
    const params = new URLSearchParams({ limit: String(limit), offset: String(offset), ...query });
    const page = (await getData<AttioTask[]>(`/tasks?${params}`)) ?? [];
    tasks.push(...page);
    if (page.length < limit) return tasks;
  }
}

function firstValue(values: Record<string, unknown[]>, keys: string[], fields: string[]): string | null {
  for (const key of keys) {
    for (const entry of values[key] ?? []) {
      if (!entry || typeof entry !== "object") continue;
      for (const field of fields) {
        const value = (entry as Record<string, unknown>)[field];
        if (typeof value === "string" && value.trim()) return value.trim();
      }
    }
  }
  return null;
}

function recordSummary(record: AttioRecord, noun: string): Omit<LinkedContext, "url" | "noun"> {
  const values = record.values;
  const name = firstValue(values, ["name"], ["full_name", "value"]) ?? `${noun} record`;
  const details = [
    firstValue(values, ["email_addresses", "email"], ["email_address", "original_email_address"]),
    firstValue(values, ["phone_numbers", "phone"], ["original_phone_number", "phone_number"]),
    firstValue(values, ["job_title", "title"], ["value"]),
    firstValue(values, ["domains"], ["domain"]),
    firstValue(values, ["primary_location"], ["locality", "region", "country_code"]),
  ].filter((value): value is string => Boolean(value));
  return { name, details };
}

/**
 * Enrich a task with a summary of each linked record. A record that can't be
 * fetched (deleted, or the token lost access) is skipped rather than failing
 * the whole sync run. `objectCache` dedupes /objects lookups across all tasks.
 */
async function linkedContext(
  task: AttioTask,
  objectCache: Map<string, Promise<AttioObject>>,
): Promise<LinkedContext[]> {
  const contexts = await Promise.all(
    (task.linked_records ?? []).map(async (linked) => {
      try {
        let object = objectCache.get(linked.target_object_id);
        if (!object) {
          object = getData<AttioObject>(`/objects/${encodeURIComponent(linked.target_object_id)}`);
          objectCache.set(linked.target_object_id, object);
        }
        const { api_slug, singular_noun } = await object;
        const record = await getData<AttioRecord>(
          `/objects/${encodeURIComponent(api_slug)}/records/${encodeURIComponent(linked.target_record_id)}`,
        );
        return { noun: singular_noun, url: record.web_url, ...recordSummary(record, singular_noun) };
      } catch (err) {
        console.warn(`Skipping linked record ${linked.target_record_id} on task ${task.id.task_id}:`, err);
        return null;
      }
    }),
  );
  return contexts.filter((context): context is LinkedContext => context !== null);
}

function memberLabel(member: AttioMember | undefined): string | null {
  if (!member) return null;
  const name = `${member.first_name} ${member.last_name}`.trim();
  return name ? `${name} (${member.email_address})` : member.email_address;
}

function toSourceItem(
  task: AttioTask,
  members: Map<string, AttioMember>,
  related: LinkedContext[],
): SourceItem {
  const slug = env.attioWorkspaceSlug();
  const firstLine = (task.content_plaintext || "(untitled Attio task)").split("\n")[0].trim();
  const title = firstLine.length > 250 ? `${firstLine.slice(0, 247)}...` : firstLine;

  const links: { label: string; url: string }[] = [];
  if (slug) links.push({ label: "Attio task", url: `https://app.attio.com/${slug}/tasks` });

  const assignees = (task.assignees ?? [])
    .map((assignee) => memberLabel(members.get(assignee.referenced_actor_id)))
    .filter((value): value is string => Boolean(value));
  const creatorId = task.created_by_actor?.id;
  const creator = creatorId ? memberLabel(members.get(creatorId)) : null;
  const extraNotes = [
    `Status: ${task.is_completed ? "Completed" : "Open"}`,
    assignees.length ? `Assignee: ${assignees.join(", ")}` : null,
    creator ? `Created by: ${creator}` : null,
    `Created: ${formatTimestamp(task.created_at)}`,
    task.deadline_at ? `Deadline: ${formatTimestamp(task.deadline_at)}` : null,
    task.completed_at ? `Completed: ${formatTimestamp(task.completed_at)}` : null,
  ].filter((line): line is string => Boolean(line));

  if (related.length) {
    extraNotes.push("", "Related records");
    for (const record of related) {
      extraNotes.push(`${record.noun}: ${record.name}`, `Attio record: ${record.url}`);
      if (record.details.length) extraNotes.push(`Details: ${record.details.join(" · ")}`);
    }
  }
  const details = task.content_plaintext?.trim();
  if (details) extraNotes.push("", "Task details", details);

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

  const [open, completed, memberList] = await Promise.all([
    listTasks({ assignee, is_completed: "false", sort: "created_at:desc" }),
    listTasks({ assignee, is_completed: "true", sort: "completed_at:desc" }),
    getData<AttioMember[]>("/workspace_members"),
  ]);

  const recentlyCompleted = completed.filter(
    (t) => t.completed_at && new Date(t.completed_at).getTime() >= sinceMs,
  );

  const tasks = [...open, ...recentlyCompleted];
  const members = new Map(memberList.map((member) => [member.id.workspace_member_id, member]));
  const objectCache = new Map<string, Promise<AttioObject>>();
  const related = await Promise.all(tasks.map((task) => linkedContext(task, objectCache)));
  return tasks.map((task, index) => toSourceItem(task, members, related[index]));
}
