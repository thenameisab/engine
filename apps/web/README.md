# @engine/web

The public site: the pre-launch landing page (`index.html`) and the
customer-facing documentation at `/docs`.

This is **not** the product app — that is `apps/dashboard`.

This package is not deployed on its own. It is **build input**: the dashboard's
build generates `docs/**` from here and mounts it at `/docs` in the single
Pages project that actually ships. See "Deploy" below.

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

To preview what actually deploys — dashboard at `/`, docs at `/docs` — build
the dashboard, since that is the build that assembles both:

```bash
pnpm --filter @engine/dashboard build && npx serve apps/dashboard/site -l 4321
```

Then open `http://localhost:4321/docs/changelog`.

`pnpm --filter @engine/web build` also produces `apps/web/site` (landing page +
docs, standalone). That is useful for working on this package alone, but it is
**not** what ships.

### `app.<something>.pages.dev` does not exist

A Pages project gets exactly one `pages.dev` hostname. Subdomains under it
resolve only as *branch previews* — `app.engine-7vv.pages.dev` would require a
git branch literally named `app`, serving production from a preview deploy that
rebuilds on every push and is excluded from search. A real `app.` subdomain
needs a custom domain: point `example.com` at this project and
`app.example.com` at the dashboard project, both as custom domains in Pages.

Until that is settled the login button in `index.html` points at
`https://engine-app.pages.dev/`. **That hostname does not exist yet** — create
the dashboard's project under that name, or update the one `href` in
`index.html` (marked `APP URL`) to whatever you choose.

## Deploy (Cloudflare Pages)

There is **one** Pages project (`engine-7vv`). It builds `apps/dashboard`, and
`apps/dashboard/scripts/assembleSite.mjs` mounts these docs into its output at
`site/docs`. Nothing here needs a project of its own.

- Build output directory: **`apps/dashboard/site`**

Do not point an output directory at `apps/web` or `apps/dashboard` themselves.
They contain `node_modules`, and pnpm's workspace symlinks make Pages fail with
*"build output directory contains links to files that can't be accessed"*. Both
`assemble-site.mjs` and `assembleSite.mjs` exist to avoid that, and both
hard-fail if a symlink survives into the output.

### Why the SPA catch-all is not a problem

The dashboard serves `index.html` for unmatched paths, which is what made
`/docs/*` return a blank shell before the docs were mounted. Real static files
win over that fallback, so once `site/docs/**` exists the docs are served
directly. `assembleSite.mjs` asserts every expected route is present for
exactly this reason: if the docs silently stop being copied, the failure mode
is not a 404 but a blank page that looks fine to monitoring.

`noindex` lives on the dashboard's own `index.html`, not on the generated docs
pages, so mounting the docs here does not hide them from search.

### What must never be published here

The constraint is about **content**, not about which project serves it.
Customer-facing docs belong on the public site. Internal documentation — the
repository layout, the stack, infrastructure, suppliers, competitive analysis,
the internal roadmap, `docs/00-Master-PRD.md` and friends — must never reach a
public URL, whichever project is doing the serving.

That rule is enforced in code, not by convention: `build-docs.mjs` fails the
build if a banned internal term reaches the rendered output, and authors every
public page from copy written on purpose rather than republishing repo
documents wholesale. Read its header comment before adding anything to `/docs`.
