import { el } from './dom.js';
import { requestAudit } from './api.js';
import { readableError } from './errors.js';
import type { AppContext } from './context.js';
import type { ApiAuditRequest } from './types.js';

/**
 * "Run audit", shared by Findings and Home.
 *
 * It lived inside Findings, which was fine while Findings was the only
 * screen that offered it. Home's empty state tells a customer with a
 * never-audited site to run an audit, and a screen that names an action it
 * does not offer is the defect the 2026-09-09 review counted four times. The
 * alternative was a second copy of the queue, disable and error handling,
 * which is how the two would drift.
 *
 * @param onQueued Re-read whatever the calling screen shows, so the status
 *   line and the disabled button reflect the request that was just made.
 */
export function runAuditButton(
  ctx: AppContext,
  latest: ApiAuditRequest | null,
  onQueued: () => Promise<void>,
  label = 'Run audit',
): HTMLElement {
  const busy = latest?.status === 'queued' || latest?.status === 'running';
  const btn = el(
    'button',
    {
      class: 'btn primary',
      ...(busy ? { disabled: 'true', title: 'An audit is already queued or running' } : {}),
      onclick: async () => {
        btn.setAttribute('disabled', 'true');
        btn.textContent = 'Queuing…';
        try {
          const { dispatched } = await requestAudit();
          ctx.toast(
            dispatched
              ? 'Audit queued. It usually finishes within a few minutes.'
              : 'Audit queued for the next scheduled pass.',
          );
          await onQueued();
        } catch (err) {
          ctx.toast(readableError(err));
          btn.removeAttribute('disabled');
          btn.textContent = label;
        }
      },
    },
    [label],
  );
  return btn;
}
