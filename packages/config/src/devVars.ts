/**
 * Generate the `.dev.vars.example` template from the integration registry, so
 * the example file and the runtime readiness check share one definition and
 * cannot drift. Rendered by a small script (see package `gen:dev-vars`) and
 * committed; never read at runtime.
 */
import { INTEGRATIONS } from './integrations.js';

export function renderDevVarsExample(): string {
  const lines: string[] = [
    '# Engine — local/dev environment variables (example)',
    '#',
    '# Copy to `.dev.vars` (gitignored) for `wrangler dev`, or set each as a',
    '# Worker secret in production via `wrangler secret put <NAME>`.',
    '# Generated from @engine/config INTEGRATIONS — edit the registry, not this file.',
    '',
  ];

  for (const integration of INTEGRATIONS) {
    lines.push(`# ── ${integration.name} (${integration.category}) ──`);
    lines.push(`# ${integration.purpose}`);
    lines.push(`# Account: ${integration.account}`);
    if (!integration.requiredForMvp) lines.push('# (optional for pre-alpha)');
    for (const v of integration.env) {
      const tags = [v.secret ? 'secret' : 'config', v.required ? 'required' : 'optional'].join(', ');
      lines.push(`# ${v.description} [${tags}]`);
      lines.push(`${v.name}=${v.example ?? ''}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
