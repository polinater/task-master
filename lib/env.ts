function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v.trim();
}

function optional(name: string, fallback = ""): string {
  const v = process.env[name];
  return v && v.trim() !== "" ? v.trim() : fallback;
}

export const env = {
  // Linear
  linearApiKey: () => required("LINEAR_API_KEY"),
  // One or more team UUIDs (comma-separated), e.g. "<uuid1>,<uuid2>".
  linearTeamIds: () =>
    required("LINEAR_TEAM_IDS")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),

  // Attio
  attioApiKey: () => required("ATTIO_API_KEY"),
  // Workspace-member email or id whose tasks should be synced.
  attioAssignee: () => required("ATTIO_ASSIGNEE"),
  // Optional: used only to build a "view in Attio" link.
  attioWorkspaceSlug: () => optional("ATTIO_WORKSPACE_SLUG"),

  // Google
  googleClientId: () => required("GOOGLE_CLIENT_ID"),
  googleClientSecret: () => required("GOOGLE_CLIENT_SECRET"),
  googleRefreshToken: () => required("GOOGLE_REFRESH_TOKEN"),
  // Target Google Tasks list titles per source. Auto-created if missing.
  linearTasklist: () => optional("LINEAR_TASKLIST", "Dev"),
  attioTasklist: () => optional("ATTIO_TASKLIST", "Sales"),

  // Upstash Redis — the mapping database. Provisioned via the Vercel
  // Marketplace, which injects these two vars automatically.
  upstashUrl: () => required("UPSTASH_REDIS_REST_URL"),
  upstashToken: () => required("UPSTASH_REDIS_REST_TOKEN"),

  // Behaviour
  // How many days back to keep looking at completed/canceled items so their
  // completion is propagated to Google before they drop out of the sync window.
  lookbackDays: () => {
    const n = parseInt(optional("SYNC_LOOKBACK_DAYS", "14"), 10);
    return Number.isFinite(n) && n > 0 ? n : 14;
  },

  // Shared secret Vercel Cron sends as `Authorization: Bearer <CRON_SECRET>`.
  // Also used to guard manual invocations. Optional but recommended.
  cronSecret: () => optional("CRON_SECRET") || undefined,
};
