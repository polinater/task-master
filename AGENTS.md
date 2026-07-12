# Agent guide

One-way sync: Linear issues + Attio tasks → Google Tasks, run hourly by a Vercel cron hitting `api/sync.ts`. Data flow: `lib/linear.ts` / `lib/attio.ts` fetch and normalize into `SourceItem`s (`lib/types.ts`) → `lib/reconcile.ts` diffs them against the mapping in Upstash Redis (`lib/store.ts`, one hash `sync:items`) → creates/completes/patches Google tasks via `lib/google.ts`.

## Commands

```bash
npm run typecheck        # tsc --noEmit
npm test                 # unit tests; no network or credentials needed
npm run dev:sync -- --dry  # full run against real Linear/Attio, read-only, prints the plan
npm run dev:sync         # LIVE: writes to the user's real Google Tasks and Redis
npm run auth             # one-time Google OAuth to mint a refresh token
```

Local runs read `.env.local` (see `.env.example` for every variable).

## Rules for agents

- **Verify with `--dry` first.** A live `dev:sync` mutates the user's real Google Tasks and the production Redis mapping. Never run it just to "check" something.
- The reconciler is source-agnostic: to change what syncs, adjust the fetchers; to change *how* it syncs, adjust `lib/reconcile.ts` — and keep `tests/reconcile.test.ts` green.
- Google Tasks PATCH semantics matter: a field set to `undefined` is dropped from the JSON and left unchanged by Google; send an explicit `null` to clear it.
- The content hash in the Redis record is how no-op updates are skipped. Any change to note/title formatting causes a one-time re-patch of every open task on the next run — harmless, but expected.
- `/api/sync` requires `CRON_SECRET` (`Authorization: Bearer <secret>`); there is no unauthenticated mode.
- No secrets belong in the repo: config comes from env vars only, documented in `.env.example`.
