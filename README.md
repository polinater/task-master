# Linear + Attio → Google Tasks sync

A lightweight, **one-way** sync that runs as an hourly [Vercel Cron](https://vercel.com/docs/cron-jobs):

- **Linear** issues in a chosen **team** → Google Tasks
- **Attio** tasks assigned to a chosen **user** → Google Tasks
- When a Linear issue or Attio task is **completed/canceled**, the matching Google task is marked **done**.

Each Google task's notes carry a link back to the source plus a readable summary — status, assignee, description, and (for Attio) a snapshot of the linked person/company record. All mapping state (source id → Google task id) lives in a single **Upstash Redis** hash, so no sync metadata is hidden in the notes and they're safe to edit.

It is intentionally not a Next.js app — just a single Vercel Function (`api/sync.ts`), a cron entry, and a Redis mapping store.

## How it works

```
Linear (team) ─┐                          ┌─ Upstash Redis (source id → Google task id)
               ├─► normalize ─► reconcile ─┤
Attio (user) ──┘                          └─► Google Tasks: create / complete / update
```

Each run loads the whole mapping from Redis in one round-trip, then for each source item:

- **Create** — an open source item with no mapping → new Google task, mapping saved.
- **Complete** — a mapped item that is now done → mark the Google task completed.
- **Update** — a mapped open item whose title/notes/due changed → patch the Google task.
- **Heal** — if the Google task was deleted by hand, the mapping is dropped (or the task recreated).
- Items already done that were never synced are skipped (no clutter).

`SYNC_LOOKBACK_DAYS` (default 14) controls how long after closing an item is still watched so its completion propagates before it drops out of the window.

## Setup

### 1. Install

Requires **Node 22.9+**.

```bash
npm install
```

### 2. Linear

- **`LINEAR_API_KEY`** — Linear → Settings → Security & access → Personal API keys.
- **`LINEAR_TEAM_IDS`** — one or more team UUIDs, comma-separated (not the `CORE` key). Find them in the team settings URL, or run:
  ```bash
  curl -s https://api.linear.app/graphql -H "Authorization: $LINEAR_API_KEY" \
    -H "Content-Type: application/json" \
    -d '{"query":"{ teams { nodes { id name key } } }"}'
  ```

### 3. Attio

- **`ATTIO_API_KEY`** — Attio → Settings → Developers → create an access token (with task read access).
- **`ATTIO_ASSIGNEE`** — the workspace member's email or id whose tasks you want.
- **`ATTIO_WORKSPACE_SLUG`** *(optional)* — only used to add a "view in Attio" link.

### 4. Google (the important one — read this)

Google Tasks needs OAuth. To keep the deployed app simple, you authorize **once locally** and store the resulting **refresh token** as an env var. The cron uses it to mint short-lived access tokens on every run.

**Refresh-token expiry — the thing you need to get right:**
Google auto-expires refresh tokens after **7 days _only while the OAuth consent screen is in "Testing" status_.** To make the token durable (effectively permanent for a cron):

- **Best (if the Google account is in your Workspace):** set the OAuth consent screen **User Type = Internal**. Tokens never expire under this rule and you skip Google's verification review.
- **Otherwise:** set the publishing status to **"In production"**. Refresh tokens then don't expire (they only die on manual revoke, password change, or 6 months of total inactivity — none of which an hourly cron hits). The Google Tasks scope is "sensitive", so you'll click through an "unverified app" warning during the one-time consent; that's fine for personal use and does not reintroduce the 7-day expiry.

**Steps:**

1. In [Google Cloud Console](https://console.cloud.google.com/) create/pick a project → **APIs & Services** → **Enable APIs** → enable **Google Tasks API**.
2. **OAuth consent screen** → configure it, add the target Google account as a test user if needed, and set it **Internal** or **In production** as above. Add the scope `https://www.googleapis.com/auth/tasks`.
3. **Credentials** → **Create Credentials** → **OAuth client ID** → type **Desktop app** (simplest) or **Web application**. If Web application, add `http://localhost:53682` as an authorized redirect URI. Copy the **client id** and **client secret**.
4. Run the one-time authorization locally:
   ```bash
   GOOGLE_CLIENT_ID=your-client-id GOOGLE_CLIENT_SECRET=your-client-secret npm run auth
   ```
   A browser opens; sign in as the **target Google account** and approve. The terminal prints:
   ```
   GOOGLE_REFRESH_TOKEN=1//0g...
   ```
5. Set **`GOOGLE_CLIENT_ID`**, **`GOOGLE_CLIENT_SECRET`**, and **`GOOGLE_REFRESH_TOKEN`** as env vars.

**Routing to lists:** Linear issues sync into the **`LINEAR_TASKLIST`** list (default `Dev`) and Attio tasks into **`ATTIO_TASKLIST`** (default `Sales`). Both lists are **created automatically** if they don't exist. Any other list you keep (e.g. `Admin`) is never touched — the sync only manages tasks it created.

### 5. Upstash Redis (mapping database)

In the Vercel dashboard → **Storage** → **Upstash** → create a **Redis** database and connect it to this project. Vercel injects **`UPSTASH_REDIS_REST_URL`** and **`UPSTASH_REDIS_REST_TOKEN`** automatically. For local dev, copy those two values into your `.env.local`. (You can also create the DB directly at [console.upstash.com](https://console.upstash.com/) and paste the REST URL + token.)

The free tier is far more than enough — this stores one small hash keyed by source id.

### 6. Deploy to Vercel

```bash
npm i -g vercel        # if needed
vercel link
# add every variable from .env.example to Production:
vercel env add LINEAR_API_KEY production
# ...repeat for each var, or paste them in the Vercel dashboard → Settings → Environment Variables
vercel deploy --prod
```

The cron in `vercel.json` calls `GET /api/sync` every hour (`0 * * * *`). **`CRON_SECRET`** is required — Vercel automatically sends it as `Authorization: Bearer <CRON_SECRET>`, and the endpoint rejects requests without it. Generate one with `openssl rand -hex 32`.

To change the frequency (e.g. 4×/day), edit `vercel.json`:
```json
{ "crons": [{ "path": "/api/sync", "schedule": "0 */6 * * *" }] }
```

## Testing locally

Copy `.env.example` to `.env.local` and fill it in, then:

```bash
# Dry run — fetches from Linear/Attio and prints what it *would* do.
# No writes to Google Tasks or Redis, and no Google credentials needed.
npm run dev:sync -- --dry

# Live run — actually creates/updates Google tasks and writes Redis.
npm run dev:sync
```

You can also exercise the deployed endpoint shape with `vercel dev`:

```bash
vercel dev
curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/sync
```

A successful run returns JSON like:
```json
{ "ok": true, "fetched": { "linear": 12, "attio": 3 }, "result": { "created": 2, "completed": 1, "updated": 0, "skipped": 12, "healed": 0 } }
```

Unit tests (no network, no credentials) and the type check:

```bash
npm test
npm run typecheck
```

## Notes & limitations

- **One-way only.** Changes made in Google Tasks are not pushed back. If you complete a task in Google but it's still open in Linear/Attio, the next run leaves Google as-is (it only *adds* completion, never reopens).
- **Only actionable Linear issues sync** by default: states of type `unstarted`/`started`, plus issues completed/canceled within the lookback window. If your todo list lives in backlog states, set `LINEAR_STATE_TYPES=unstarted,started,backlog`.
- **Deletions** in the source are not propagated; the Google task simply stops being updated.
- **Attio tasks have no public URL** in the API, so the notes link to the Attio tasks view; linked person/company records get direct links.
- **No overlap guard.** Runs are hourly and take seconds, so overlap is unlikely — but a manual run racing the cron could double-create a task.
- **Heartbeat:** every live run writes `sync:lastRun` in Redis (timestamp, runtime, result counts) — check it first when wondering whether the cron is running.
- **All matching state lives in Upstash Redis** (one hash, `sync:items`). If you wipe that database, the next run treats every open item as new and recreates its Google task — it won't find the existing ones. The task notes themselves contain no sync metadata, so they're safe to edit.

## Files

| Path | Purpose |
|------|---------|
| `api/sync.ts` | The cron endpoint / orchestrator |
| `lib/linear.ts` | Fetch + normalize Linear issues |
| `lib/attio.ts` | Fetch + normalize + enrich Attio tasks |
| `lib/google.ts` | Google Tasks REST client + token refresh |
| `lib/store.ts` | Upstash Redis mapping store (the database) |
| `lib/reconcile.ts` | Create/complete/update/heal logic |
| `scripts/google-auth.mjs` | One-time local OAuth to get the refresh token |
| `scripts/sync-local.ts` | Run a sync (or `--dry` run) from your terminal |
| `tests/` | Unit tests (`npm test`) — no network or credentials needed |
| `vercel.json` | Cron schedule + function config |

## License

[MIT](LICENSE)
