import { env } from "./env";
import type { SourceItem } from "./types";

const API_URL = "https://api.linear.app/graphql";

const QUERY = `
  query TeamIssues($teamId: String!, $after: String, $filter: IssueFilter) {
    team(id: $teamId) {
      issues(first: 100, after: $after, filter: $filter) {
        nodes {
          id
          identifier
          title
          description
          url
          dueDate
          priorityLabel
          createdAt
          updatedAt
          completedAt
          canceledAt
          state { name type }
          assignee { name email }
          project { name }
          cycle { name number }
          parent { identifier title }
          labels { nodes { name } }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  dueDate: string | null;
  priorityLabel: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  canceledAt: string | null;
  state: { name: string; type: string };
  assignee: { name: string; email: string } | null;
  project: { name: string } | null;
  cycle: { name: string | null; number: number } | null;
  parent: { identifier: string; title: string } | null;
  labels: { nodes: { name: string }[] };
}

function dateLabel(value: string | null): string | null {
  if (!value) return null;
  return new Date(value).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

function linearNotes(issue: LinearIssue): string[] {
  const lines = [
    `Status: ${issue.state.name}`,
    `Priority: ${issue.priorityLabel || "No priority"}`,
    issue.assignee ? `Assignee: ${issue.assignee.name} (${issue.assignee.email})` : "Assignee: Unassigned",
    issue.project ? `Project: ${issue.project.name}` : null,
    issue.cycle ? `Cycle: ${issue.cycle.name || `#${issue.cycle.number}`}` : null,
    issue.parent ? `Parent: ${issue.parent.identifier} — ${issue.parent.title}` : null,
    issue.labels.nodes.length ? `Labels: ${issue.labels.nodes.map((label) => label.name).join(", ")}` : null,
    issue.dueDate ? `Due: ${issue.dueDate}` : null,
    `Created: ${dateLabel(issue.createdAt)}`,
    `Updated: ${dateLabel(issue.updatedAt)}`,
    issue.completedAt ? `Completed: ${dateLabel(issue.completedAt)}` : null,
    issue.canceledAt ? `Canceled: ${dateLabel(issue.canceledAt)}` : null,
  ].filter((line): line is string => Boolean(line));

  if (issue.description?.trim()) lines.push("", "Description", issue.description.trim());
  return lines;
}

async function graphql(variables: Record<string, unknown>): Promise<any> {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      // Linear personal API keys go in Authorization with no "Bearer" prefix.
      Authorization: env.linearApiKey(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: QUERY, variables }),
  });
  if (!res.ok) {
    throw new Error(`Linear API request failed (${res.status}): ${await res.text()}`);
  }
  const json = (await res.json()) as { data?: any; errors?: unknown };
  if (json.errors) {
    throw new Error(`Linear GraphQL errors: ${JSON.stringify(json.errors)}`);
  }
  return json.data;
}

/**
 * Fetch issues for the configured team that are either currently active
 * (unstarted/started) or were closed within the lookback window (so their
 * completion still propagates to Google before they age out).
 */
export async function fetchLinearItems(): Promise<SourceItem[]> {
  const since = new Date(Date.now() - env.lookbackDays() * 24 * 60 * 60 * 1000).toISOString();
  const filter = {
    or: [
      { state: { type: { in: ["unstarted", "started"] } } },
      { completedAt: { gt: since } },
      { canceledAt: { gt: since } },
    ],
  };

  const items: SourceItem[] = [];
  const list = env.linearTasklist();

  for (const teamId of env.linearTeamIds()) {
    let after: string | null = null;
    do {
      const data = await graphql({ teamId, after, filter });
      const team = data.team;
      if (!team) throw new Error(`Linear team not found for id "${teamId}". Check LINEAR_TEAM_IDS.`);

      for (const issue of team.issues.nodes as LinearIssue[]) {
        // Linear models "Duplicate" as its own terminal state type even though
        // it also sets canceledAt. It must not remain actionable in Google.
        const done = ["completed", "canceled", "duplicate"].includes(issue.state.type);
        items.push({
          key: `linear:${issue.id}`,
          title: `${issue.identifier}: ${issue.title}`,
          list,
          identifier: issue.identifier,
          done,
          due: issue.dueDate ? `${issue.dueDate}T00:00:00.000Z` : null,
          links: [{ label: "Linear issue", url: issue.url }],
          extraNotes: linearNotes(issue),
        });
      }

      after = team.issues.pageInfo.hasNextPage ? team.issues.pageInfo.endCursor : null;
    } while (after);
  }

  return items;
}
