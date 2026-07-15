/**
 * Regenerate apps/api/.dev.vars.example from the @engine/config integration
 * registry. Run after `pnpm --filter @engine/config build`:
 *   pnpm --filter @engine/config gen:dev-vars
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { renderDevVarsExample } from '../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const target = resolve(here, '../../../apps/api/.dev.vars.example');
writeFileSync(target, renderDevVarsExample(), 'utf8');
console.log(`Wrote ${target}`);
