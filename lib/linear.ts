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
          url
          dueDate
          state { type }
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
  url: string;
  dueDate: string | null;
  state: { type: string };
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
        const done = issue.state.type === "completed" || issue.state.type === "canceled";
        items.push({
          key: `linear:${issue.id}`,
          title: `${issue.identifier}: ${issue.title}`,
          list,
          identifier: issue.identifier,
          done,
          due: issue.dueDate ? `${issue.dueDate}T00:00:00.000Z` : null,
          links: [{ label: "Linear issue", url: issue.url }],
        });
      }

      after = team.issues.pageInfo.hasNextPage ? team.issues.pageInfo.endCursor : null;
    } while (after);
  }

  return items;
}
