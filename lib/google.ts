import { env } from "./env";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API_BASE = "https://tasks.googleapis.com/tasks/v1";

export interface GoogleTask {
  id: string;
  title?: string;
  notes?: string;
  status?: "needsAction" | "completed";
  due?: string;
}

interface TaskWrite {
  title: string;
  notes?: string;
  due?: string;
}

export class GoogleApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GoogleApiError";
  }
}

/** Exchange the long-lived refresh token for a short-lived access token. */
async function getAccessToken(): Promise<string> {
  const body = new URLSearchParams({
    client_id: env.googleClientId(),
    client_secret: env.googleClientSecret(),
    refresh_token: env.googleRefreshToken(),
    grant_type: "refresh_token",
  });

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Google token refresh failed (${res.status}): ${text}. ` +
        `If this says "invalid_grant", the refresh token was revoked or expired — ` +
        `re-run \`npm run auth\` (and make sure the OAuth consent screen is "In production" or "Internal").`,
    );
  }

  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new Error("Google token response had no access_token");
  return json.access_token;
}

export class GoogleTasksClient {
  constructor(
    private readonly token: string,
    private readonly tasklist: string,
  ) {}

  private async call(path: string, init: RequestInit = {}): Promise<any> {
    const res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new GoogleApiError(
        `Google Tasks API ${init.method ?? "GET"} ${path} failed (${res.status}): ${text}`,
        res.status,
      );
    }
    if (res.status === 204) return null;
    return res.json();
  }

  private list() {
    return `/lists/${encodeURIComponent(this.tasklist)}/tasks`;
  }

  async insert(task: TaskWrite): Promise<GoogleTask> {
    return this.call(this.list(), {
      method: "POST",
      body: JSON.stringify({ ...task, status: "needsAction" }),
    });
  }

  async patch(id: string, fields: Partial<TaskWrite>): Promise<GoogleTask> {
    return this.call(`${this.list()}/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(fields),
    });
  }

  async complete(id: string): Promise<GoogleTask> {
    return this.call(`${this.list()}/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "completed" }),
    });
  }
}

export async function createGoogleTasksClient(): Promise<GoogleTasksClient> {
  const token = await getAccessToken();
  return new GoogleTasksClient(token, env.googleTasklistId());
}
