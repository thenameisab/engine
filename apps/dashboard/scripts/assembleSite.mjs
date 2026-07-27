/**
 * Assemble a clean, symlink-free deploy directory (`site/`) after `tsc`.
 *
 * Cloudflare Pages refuses an output directory containing symlinks it can't
 * resolve ("build output directory contains links to files that can't be
 * accessed") — and a pnpm workspace's `node_modules` is full of them. Pointing
 * Pages at `apps/dashboard` (which has `node_modules` next to `dist/`) hits
 * that every time. So `site/` holds only what the browser actually needs:
 * `index.html`, `styles.css`, and the compiled `dist/*.js` — real files,
 * copied, never symlinked.
 *
 * This directory is also the ONLY thing the Pages project publishes, so the
 * public docs have to be assembled into it too. `apps/web` is not a separate
 * deploy — it is build input for `site/docs`. Without this step every
 * `/docs/*` URL falls through to the SPA shell below and renders blank, which
 * is exactly what production was doing.
 */
import { cpSync, readFileSync, writeFileSync, rmSync, mkdirSync, readdirSync, statSync, lstatSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const site = join(root, 'site');
const web = join(root, '..', 'web');

rmSync(site, { recursive: true, force: true });
mkdirSync(site, { recursive: true });

cpSync(join(root, 'dist'), join(site, 'dist'), { recursive: true, dereference: true });
cpSync(join(root, 'styles.css'), join(site, 'styles.css'), { dereference: true });

const html = readFileSync(join(root, 'index.html'), 'utf8');
writeFileSync(join(site, 'index.html'), html);

/* ——— Public docs, mounted at /docs ———————————————————————————————
   build-docs.mjs regenerates apps/web/docs from apps/web/content and its own
   authored copy; it resolves every path from its own location, so cwd here is
   irrelevant. stdio:'inherit' means its BANNED-term check fails this build
   loudly rather than shipping a half-built docs tree. */
execFileSync(process.execPath, [join(web, 'build-docs.mjs')], { stdio: 'inherit' });
cpSync(join(web, 'docs'), join(site, 'docs'), { recursive: true, dereference: true });

/* Verify what this script promises: no symlink survived (Pages rejects the
   whole deploy for one), and every route the docs nav links to is really a
   file. A silent miss here is a blank page in production. */
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (lstatSync(p).isSymbolicLink()) {
      console.error(`assembleSite: symlink survived at ${relative(site, p)} — Pages will reject this.`);
      process.exit(1);
    }
    if (statSync(p).isDirectory()) walk(p);
    else files.push(relative(site, p));
  }
})(site);

const required = [
  'index.html',
  'styles.css',
  'docs/index.html',
  'docs/docs.css',
  'docs/changelog/index.html',
  'docs/features/index.html',
  'docs/roadmap/index.html',
];
const missing = required.filter((f) => !files.includes(f));
if (missing.length) {
  console.error('assembleSite: expected routes missing from the output:\n  ' + missing.join('\n  '));
  process.exit(1);
}

console.log(`Assembled ${site} — ${files.length} files, no symlinks.`);
