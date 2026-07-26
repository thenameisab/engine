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

## Which hostname serves what

The **root** hostname must serve this app, not the dashboard. Someone arriving
at the domain should land on the site and be able to read the docs — a login
screen at the front door hides everything the product has to say for itself,
and makes the documentation unreachable for anyone without an account.

| Hostname | Serves | Output directory |
|---|---|---|
| the root domain | landing page + `/docs` | `apps/web/site` |
| the app hostname | the product | `apps/dashboard/site` |

Today the root (`engine-7vv.pages.dev`) still serves the dashboard, which is
why the docs 404 there. Fixing it is a Cloudflare dashboard change, not a code
change: repoint that project's build output at `apps/web/site`, and give the
dashboard a project of its own.

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
