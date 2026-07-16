# @engine/dashboard

The Engine product dashboard — the internal pre-alpha SPA that consumes
`apps/api`. Distinct from `apps/web` (the marketing placeholder). No framework,
no bundler: TypeScript compiled to browser ES modules, served static on
Cloudflare Pages.

## Auth
The app opens on a cinematic sign-in screen and only mounts once
authenticated. Wired to **Neon Auth (Better Auth)**, SDK-free — see
`src/auth/`. Google sign-in redirects into Better Auth's hosted OAuth; a dev
session is used as a fallback wherever a real session can't be established
(e.g. an untrusted origin). Sign out from the sidebar footer.

## Views
- **Pulse** — Unified Visibility Score with its confidence band (the signature),
  channel decomposition (organic / AI Share-of-Model ±range / local), trend
  sparkline, wins & risks.
- **SERP Inspector** — a live Google keyword lookup via Serper: AI Overview
  presence, SERP features, your domain's computed rank, competitor hosts.
- **Fix Queue** — the lifecycle kanban (proposed → approved → deployed →
  verified). Card actions call the live transition endpoints and fall back to a
  local move when there's no live DB.
- **Audit** — the B1 findings inventory (severity, predicted impact, auto-fixable).
- **Settings** — API base URL + project id (persisted in `localStorage`), plus
  the Integrations readiness grid (`GET /health/integrations`).

## Live vs. sample
Every data-backed view tries the live API first and falls back to built-in
sample data — no UI badge, just working data when it's there. Two routes work
live without a database: `/health/integrations` and `/projects/:id/pulse` (the
A3 score math is pure). DB-backed views stay on sample until Postgres is
wired. Set the API base URL under **Settings** (blank = all sample).

## Develop
```
pnpm --filter @engine/dashboard build     # tsc → dist/, then assembles site/
pnpm --filter @engine/dashboard test      # vitest (pure helpers)
pnpm --filter @engine/dashboard dev       # tsc --watch (dist/ only, no site/)
# then serve the assembled output, e.g.:
cd apps/dashboard/site && npx serve .     # open /index.html
```

## Deploy (Cloudflare Pages)
- Build command: `pnpm install --frozen-lockfile && pnpm --filter @engine/dashboard build`
- Build output directory: **`apps/dashboard/site`**

Don't point the output directory at `apps/dashboard` itself — it still
contains `node_modules`, and pnpm's workspace symlinks make Cloudflare Pages
fail with *"build output directory contains links to files that can't be
accessed."* `pnpm build` runs `scripts/assembleSite.mjs` after `tsc`, which
copies just `index.html` + `styles.css` + the compiled `dist/*.js` into a
clean `site/` directory (real files, no symlinks) — that's what Pages should
serve. `site/` is gitignored, rebuilt every deploy.

For Google sign-in to work on the deployed URL, add it to **Neon Auth's
trusted origins** in the Neon console — otherwise the OAuth callback 403s.
