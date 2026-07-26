/**
 * Assembles a clean, symlink-free deploy directory at apps/web/site.
 *
 * Cloudflare Pages cannot be pointed at apps/web directly: the folder contains
 * node_modules, and under a pnpm workspace that is a tree of symlinks. Pages
 * rejects it with "build output directory contains links to files that can't
 * be accessed" — the same failure apps/dashboard hit, fixed the same way.
 *
 * Copies only what the public site serves — index.html and the generated
 * docs/ tree — as real files. Everything else in apps/web is build input
 * (build-docs.mjs, content/, docs.css, package.json, node_modules) and must
 * not ship.
 *
 * site/ is gitignored and rebuilt on every deploy.
 *
 * Run: pnpm --filter @engine/web build   (runs build-docs.mjs first)
 */

import { cpSync, existsSync, mkdirSync, rmSync, readdirSync, statSync, lstatSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = dirname(fileURLToPath(import.meta.url));
const SITE = join(WEB, 'site');

/** Only these ship. Anything not listed is build input, not output. */
const PUBLISH = ['index.html', 'docs'];

rmSync(SITE, { recursive: true, force: true });
mkdirSync(SITE, { recursive: true });

for (const entry of PUBLISH) {
  const from = join(WEB, entry);
  if (!existsSync(from)) {
    console.error(`assemble-site: missing ${entry} — did build-docs.mjs run?`);
    process.exit(1);
  }
  // dereference:true turns any symlink into a real file, which is the whole point.
  cpSync(from, join(SITE, entry), { recursive: true, dereference: true });
}

/* Verify the promise this script exists to make: zero symlinks, and every
   route the nav links to is present. A silent miss here is a blank page in
   production, which is exactly the failure this replaces. */
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (lstatSync(p).isSymbolicLink()) {
      console.error(`assemble-site: symlink survived at ${relative(SITE, p)} — Pages will reject this.`);
      process.exit(1);
    }
    if (statSync(p).isDirectory()) walk(p);
    else files.push(relative(SITE, p));
  }
})(SITE);

const REQUIRED = [
  'index.html',
  'docs/index.html',
  'docs/docs.css',
  'docs/changelog/index.html',
  'docs/features/index.html',
  'docs/roadmap/index.html',
];
const missing = REQUIRED.filter((f) => !files.includes(f));
if (missing.length) {
  console.error('assemble-site: expected routes are missing from the output:\n  ' + missing.join('\n  '));
  process.exit(1);
}

console.log(`Assembled apps/web/site — ${files.length} files, no symlinks.`);
