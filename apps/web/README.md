# @engine/web

The public site: the pre-launch landing page (`index.html`) and the
customer-facing documentation at `/docs`.

This is **not** the product app — that is `apps/dashboard`, a separate
Cloudflare Pages project.

## Build

```bash
pnpm --filter @engine/web build
```

Two steps:

1. `build-docs.mjs` generates `docs/**` — the documentation pages. It refuses
   to publish if an internal term (repository layout, stack, infrastructure,
   suppliers, competitive analysis) reaches the rendered output. `/docs` is a
   customer artifact; see the header comment in that file before adding copy.
2. `assemble-site.mjs` copies `index.html` + `docs/` into a clean `site/`
   directory as real files, and fails if a symlink survives or an expected
   route is missing.

`docs/` is committed. `site/` is gitignored and rebuilt on every deploy.

## Local preview

```bash
pnpm --filter @engine/web build && npx serve apps/web/site -l 4321
```

Then open `http://localhost:4321/docs/changelog`.

## Deploy (Cloudflare Pages)

This app needs **its own Pages project**, separate from the dashboard.

- Build command: `pnpm install --frozen-lockfile && pnpm --filter @engine/web build`
- Build output directory: **`apps/web/site`**

Do not point the output directory at `apps/web` itself. It contains
`node_modules`, and pnpm's workspace symlinks make Pages fail with *"build
output directory contains links to files that can't be accessed"* — the same
failure `apps/dashboard` hit. `assemble-site.mjs` exists to avoid it.

### Do not serve /docs from the dashboard project

The dashboard is a single-page app: its Pages project serves `index.html` for
every path, so a request for `/docs/changelog` returns the app shell, the
router finds no matching route, and the visitor gets a blank screen. The
dashboard is also `noindex`, which would hide the documentation from search —
for a product about being findable, that is the wrong outcome.
