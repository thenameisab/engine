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

### Why the product is at a path, not a subdomain

A Pages project gets exactly one `pages.dev` hostname. Subdomains under it
resolve only as *branch previews* — `app.engine-7vv.pages.dev` would require a
git branch literally named `app`, serving production from a preview deploy that
rebuilds on every push and is excluded from search. So on `pages.dev` there is
no honest way to split the product onto its own hostname; `/app` is the one
that works today, and it needs no DNS.

If you later want `app.example.com`, that needs a **custom domain**: point
`example.com` and `app.example.com` at Pages. Moving the product to its own
hostname then means changing two things — the `APP URL` link in `index.html`,
and the OAuth callback allowlist (see below).

## Deploy (Cloudflare Pages)

There is **one** Pages project (`engine-7vv`). It builds `apps/dashboard`, and
`apps/dashboard/scripts/assembleSite.mjs` assembles the whole public surface
into its output. Nothing here needs a project of its own.

- Build output directory: **`apps/dashboard/site`**

### It deploys itself now

`.github/workflows/ci.yml` publishes on every push to `main`, after typecheck,
build and tests pass. Before this existed, merging deployed nothing and the
live site served the last hand-uploaded build — for a stretch, one from July,
which is why a login fix that had already merged appeared not to work. If the
site ever looks stale again, check the `deploy` job first, not the code.

It needs three things configured on the repository, none of which live in git:

| Name | Where | Value |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | Actions **secret** | A Cloudflare API token with the **Cloudflare Pages: Edit** permission |
| `CLOUDFLARE_ACCOUNT_ID` | Actions **secret** | The Cloudflare account id that owns `engine-7vv` |
| `ENGINE_API_BASE` | Actions **variable** | The deployed API origin, e.g. `https://engine-api.<subdomain>.workers.dev` |

`ENGINE_API_BASE` is a *variable* rather than a secret on purpose. It is
written into a public page, so it is not confidential, and a secret would be
masked in the build log — hiding the one place its value can be checked.

Unset, the deploy **fails** rather than publishing. `assembleSite.mjs` only
warns, which is right for a local build (the app falls back to
`http://localhost:8787`), but a deployed build without it is a site nobody can
sign in to, because sign-in goes through the API. The job then re-reads the
assembled `app/index.html` and refuses to publish unless the origin is really
baked in — asserting the artifact, not the intent, because the way this fails
is silent (see `turbo.json`'s `build.env`).

### The API Worker deploys too

The same workflow's `deploy-api` job runs `wrangler deploy` on `apps/api`, and
the Pages job waits on it — publishing a dashboard whose backend failed to
deploy is the failure this is all here to stop. The token therefore needs
**Workers Scripts: Edit** as well as **Cloudflare Pages: Edit**.

It deploys **code only**. The Worker's secrets are set once against the Worker
itself (`wrangler secret put`, or the Cloudflare dashboard) and survive every
later deploy. They are deliberately not routed through CI, which would put the
database URL and three people's passwords in a second system to leak from. The
minimum for anyone to sign in:

| Secret | Without it |
|---|---|
| `DATABASE_URL` | Every DB-backed route fails |
| `LOCAL_AUTH_SECRET` | `POST /auth/login` → "Credential sign-in is not configured on this deployment" |
| `LOCAL_AUTH_USERS` | same |

`AUTH_JWKS_URL` is already a plaintext var in `wrangler.toml`, and CORS
defaults to `*`, so neither blocks a first deploy. Everything else in
`wrangler.toml`'s secret catalogue gates only its own feature.

`ENGINE_API_BASE` must equal the Worker's deployed origin. `wrangler deploy`
prints it — that output is the authoritative source, not a guess about the
account subdomain. `GOOGLE_REDIRECT_URI` must be that same origin plus
`/oauth/google/callback`, byte for byte.

| URL | Serves | Source |
|---|---|---|
| `/` | landing page | `apps/web/index.html` |
| `/docs` | public docs | `apps/web/docs` (generated) |
| `/app` | the product | `apps/dashboard` |

The landing page and docs sit at the root because they are what a visitor and a
crawler should find at the domain — a login screen at the front door hides
everything the product has to say for itself. The dashboard can live under
`/app` because it is **hash-routed** (`location.hash`, see
`apps/dashboard/src/shell.ts`), so in-app routes are `/app/#/pulse` and no
server-side SPA fallback is involved, and because its asset paths are relative
(`./styles.css`, `./dist/app.js`) so they resolve under `/app` unchanged.

The "Log in" link in `index.html` points at `/app/` — same origin, so there is
no second hostname to create.

Do not point an output directory at `apps/web` or `apps/dashboard` themselves.
They contain `node_modules`, and pnpm's workspace symlinks make Pages fail with
*"build output directory contains links to files that can't be accessed"*. Both
`assemble-site.mjs` and `assembleSite.mjs` exist to avoid that, and both
hard-fail if a symlink survives into the output.

### OAuth callback URL

`apps/dashboard/src/auth/neonAuth.ts` sends `callbackURL: location.href`, so
the callback follows wherever the app is served from. Moving the product from
`/` to `/app` changed it to `https://engine-7vv.pages.dev/app/`, which must be
allowlisted in Neon Auth or Google sign-in fails on redirect back.

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
