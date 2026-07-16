# @engine/dashboard

The Engine product dashboard — the internal pre-alpha SPA that consumes
`apps/api`. Distinct from `apps/web` (the marketing placeholder). No framework,
no bundler: TypeScript compiled to browser ES modules, served static on
Cloudflare Pages.

## Views
- **Pulse** — Unified Visibility Score with its confidence band (the signature),
  channel decomposition (organic / AI Share-of-Model ±range / local), trend
  sparkline, wins & risks.
- **Fix Queue** — the lifecycle kanban (proposed → approved → deployed →
  verified). Card actions call the live transition endpoints and fall back to a
  local move when there's no live DB.
- **Audit** — the B1 findings inventory (severity, predicted impact, auto-fixable).
- **Integrations** — reads `GET /health/integrations` live and shows what's wired.
- **Settings** — point the app at a running `apps/api` (base URL + project id,
  persisted in `localStorage`).

## Live vs. sample
Every view tries the live API and falls back to built-in sample data, showing a
`live` / `sample` badge. Two routes work live without a database and are the
real wiring proof: `/health/integrations` and `/projects/:id/pulse` (the A3
score math is pure). DB-backed views stay on sample until Postgres is wired.
Set the API base URL under **Settings** (blank = all sample).

## Develop
```
pnpm --filter @engine/dashboard build     # tsc → dist/ ES modules
pnpm --filter @engine/dashboard test      # vitest (pure helpers)
pnpm --filter @engine/dashboard dev        # tsc --watch
# then serve the app dir statically, e.g.:
cd apps/dashboard && npx serve .           # open /index.html
```

## Deploy (Cloudflare Pages)
- Build command: `pnpm --filter @engine/dashboard build`
- Output directory: `apps/dashboard` (serves `index.html`, `styles.css`, `dist/`)
