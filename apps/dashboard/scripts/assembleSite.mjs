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
 */
import { cpSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const site = join(root, 'site');

rmSync(site, { recursive: true, force: true });
mkdirSync(site, { recursive: true });

cpSync(join(root, 'dist'), join(site, 'dist'), { recursive: true, dereference: true });
cpSync(join(root, 'styles.css'), join(site, 'styles.css'), { dereference: true });

const html = readFileSync(join(root, 'index.html'), 'utf8');
writeFileSync(join(site, 'index.html'), html);

console.log(`Assembled ${site}`);
