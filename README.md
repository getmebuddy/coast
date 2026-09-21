# Coast — the financial-planning app

Budgeting apps tell you where money *went*. Coast computes where you're *going* — savings rate → projected FIRE date — and ties every dollar to that finish line.

**Stack (locked):** Next.js 14 App Router · TypeScript · Tailwind CSS · Supabase (Postgres + Auth) · Plaid (sandbox first) · Vercel. Money is integer cents everywhere. Custom SVG hero visuals — no chart libraries.

## Status

M1/M2 concepts are scaffolded and working in **demo mode** (seeded ledger, no keys needed):
- **Home** — TrajectoryRing (% of the way to the number), safe-to-spend, subscription reveal, animated hero numbers
- **Brief** — morning brief computed from the ledger: new activity, bills due, budget pace, subscription price watch, FIRE nudge + a designed share card (Web Share API on mobile, copy + PNG fallback on desktop)
- **Activity** — searchable ledger; transfers and card payments never count as spending
- **Budgets** — monthly ceiling + per-category pace; tap to drill into that month's charges, biggest first
- **The Number** — FIRE assumptions, projected date, what-if sliders that recompute live on every input event, saved-plan comparison

## Setup

### 1. Supabase project
1. Create a free project at [supabase.com](https://supabase.com).
2. Open the SQL editor and run `supabase/migrations/001_schema.sql` — this creates the immutable ledger, RLS policies (users see only their own rows), and the `brief_reads` table.
3. Copy the project URL + anon key (Settings → API), and the service-role key.

### 2. Install + env
```bash
cd build/coast-nextjs
npm install
cp .env.example .env.local
# fill in NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
npm run dev
```
Open [http://localhost:3000](http://localhost:3000). Demo mode works immediately — sign-in is optional.

### 3. Checks
```bash
npm test        # FIRE engine unit tests (vitest)
npm run typecheck
npm run build
```

### 4. Plaid sandbox keys (later — needed for real bank connection)
1. Free signup at [dashboard.plaid.com](https://dashboard.plaid.com) (~10 min).
2. Put the **sandbox** keys in `.env.local`:
   ```
   PLAID_CLIENT_ID=...
   PLAID_SECRET=...
   PLAID_ENV=sandbox
   ```
3. Restart `npm run dev`. The app will call `POST /api/plaid/link-token` instead of returning 503, and `POST /api/plaid/sync` will run the cursor-based, idempotent sync. No code changes needed.
4. **Production Plaid keys come later** (M6) — they require Plaid production approval and a deployed URL for OAuth redirects.

### 5. Deploy to Vercel
```bash
npx vercel
# add the same env vars in the Vercel dashboard (Project → Settings → Environment Variables)
```
Vercel picks up the Next.js app automatically. Secrets live in env vars only — never in the repo.

## Key design decisions

- **Money as integer cents** — no floats cross a function boundary (`lib/fire.ts`).
- **Immutable ledger** — transactions are never updated; corrections live in `transaction_overrides`; `category_rules` learn from every edit.
- **Transfers & credit-card payments never count as spending** (`lib/ledger.ts` classification) — the classic budget-app lie, fixed.
- **Stable-ID dedupe** — upsert on `(user_id, source, source_id)`; re-running sync never duplicates.
- **Cursor-based Plaid sync** — the cursor advances only after a successful commit; the access token is AES-256-GCM encrypted at rest and never sent to the client.
- **Demo mode first** — the app is fully usable with seeded data before any Plaid keys exist.
- **v1 exclusions honored** — no native mobile, no credit monitoring, no bill negotiation, no concierge, no household mode, no public API, no multi-aggregator, no crypto, no tax filing, no BNPL, no checking-account products.

## Scripts

| Command | What |
|---|---|
| `npm run dev` | local dev server |
| `npm test` | FIRE engine tests (vitest) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build` | production build |

## Still needed from the founder

1. **Supabase project** (free, ~5 min) + run the migration.
2. **Vercel account** to deploy (or run locally — `npm run dev`).
3. **Plaid sandbox keys** (free, ~10 min) when ready for real bank connection.
