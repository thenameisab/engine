import { el } from '../dom.js';
import { ICONS } from '../icons.js';
import { startAuthBackdrop } from './background.js';
import { signInWithGoogle } from './neonAuth.js';
import { AUTH_EVENT } from './session.js';

const GOOGLE_G = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
  <path fill="#4285F4" d="M23.52 12.27c0-.79-.07-1.54-.2-2.27H12v4.51h6.47a5.53 5.53 0 0 1-2.4 3.63v3h3.88c2.27-2.09 3.57-5.17 3.57-8.87z"/>
  <path fill="#34A853" d="M12 24c3.24 0 5.95-1.08 7.94-2.91l-3.88-3c-1.08.72-2.45 1.16-4.06 1.16-3.12 0-5.77-2.11-6.71-4.94H1.28v3.09A12 12 0 0 0 12 24z"/>
  <path fill="#FBBC05" d="M5.29 14.31A7.2 7.2 0 0 1 4.9 12c0-.8.14-1.58.39-2.31V6.6H1.28A12 12 0 0 0 0 12c0 1.94.46 3.77 1.28 5.4l4.01-3.09z"/>
  <path fill="#EA4335" d="M12 4.75c1.76 0 3.34.61 4.58 1.8l3.44-3.44C17.95 1.19 15.24 0 12 0A12 12 0 0 0 1.28 6.6l4.01 3.09C6.23 6.86 8.88 4.75 12 4.75z"/>
</svg>`;

/**
 * The sign-in screen. Google only.
 *
 * The email field is gone. Better Auth's magic-link plugin is not enabled on
 * this Neon Auth instance — `POST /sign-in/magic-link` answers 404 — so the
 * control could never sign anyone in. Its only working behaviour was the local
 * "dev session" fallback that admitted whatever address was typed, which is
 * exactly what should not exist. Restoring it is a matter of enabling the
 * plugin server-side and reinstating this field plus `sendEmailLink`.
 */
export function mountAuthScreen(root: HTMLElement): void {
  root.replaceChildren();

  const canvas = el('canvas', { class: 'auth-bg' }) as HTMLCanvasElement;

  const note = el('p', { class: 'auth-note' });

  /** Show a failure on the card. Sign-in errors have nowhere else to go — there is no shell yet. */
  const showError = (message: string) => {
    note.textContent = message;
    note.classList.add('show', 'error');
  };

  const card = el('div', { class: 'auth-card' }, [
    el('div', { class: 'auth-brand' }, [
      el('span', { class: 'auth-mark', html: `<svg viewBox="0 0 24 24" fill="none">${ICONS.logo}</svg>` }),
      el('span', { class: 'auth-word' }, ['Engine']),
    ]),
    el('h1', { class: 'auth-title' }, ['Sign in']),
    el('p', { class: 'auth-sub' }, ['Your AI & search visibility — and the fixes that move it.']),

    el('button', {
      class: 'auth-btn provider',
      onclick: (e: Event) => {
        const btn = e.currentTarget as HTMLButtonElement;
        btn.setAttribute('disabled', 'true');
        note.classList.remove('show', 'error');
        void signInWithGoogle().catch((err: Error) => {
          // Only reached when the redirect never happens — on success the
          // browser has already left this page.
          btn.removeAttribute('disabled');
          showError(err.message);
        });
      },
      html: `${GOOGLE_G}<span>Continue with Google</span>`,
    }),

    note,

    el('p', { class: 'auth-foot' }, ['Invite-only · pre-alpha access']),
  ]);

  const screen = el('div', { class: 'auth-screen' }, [
    canvas,
    el('div', { class: 'auth-vignette' }),
    el('div', { class: 'auth-center' }, [card]),
  ]);

  root.append(screen);

  const backdrop = startAuthBackdrop(canvas);
  // Tear the animation down when the user signs in (the app re-boots into the shell).
  addEventListener(AUTH_EVENT, () => backdrop.stop(), { once: true });
}
