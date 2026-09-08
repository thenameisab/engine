import { el } from '../dom.js';
import { ICONS } from '../icons.js';
import { signInWithPassword } from './passwordAuth.js';

/**
 * The sign-in screen: email, password, one button. Exactly that, and nothing
 * else — no third field for the API URL, which briefly lived here and asked
 * every user to know a deployment detail. `getApiBaseUrl()` resolves it from
 * the build (or from being on localhost) instead; see `api.ts`.
 *
 * **No motion.** The previous version ran an animated canvas backdrop behind
 * the card (`background.ts`, now deleted) — a continuous requestAnimationFrame
 * loop on the first screen of the product, burning a core to decorate a form
 * nobody looks at for more than four seconds. Nothing here animates, and the
 * screen is a static paint.
 *
 * **No Google button.** Google sign-in cannot complete from the deployed
 * origin — Neon Auth answers `403 INVALID_CALLBACKURL` because that origin is
 * not on its trusted-origins list — so the control could only ever fail. The
 * machinery is intact in `neonAuth.ts`; restoring the button is adding the
 * origin in the Neon Auth console and reverting this file's hunk.
 *
 * Errors render on the card because there is nowhere else for them to go:
 * there is no shell yet, so no toast host.
 */
export function mountAuthScreen(root: HTMLElement): void {
  root.replaceChildren();

  const note = el('p', { class: 'auth-note', role: 'alert' });
  const showError = (message: string) => {
    note.textContent = message;
    note.classList.add('show');
  };
  const clearError = () => {
    note.textContent = '';
    note.classList.remove('show');
  };

  const email = el('input', {
    class: 'auth-field',
    type: 'email',
    name: 'email',
    id: 'auth-email',
    autocomplete: 'username',
    placeholder: 'you@company.com',
    required: true,
  }) as HTMLInputElement;

  const password = el('input', {
    class: 'auth-field',
    type: 'password',
    name: 'password',
    id: 'auth-password',
    autocomplete: 'current-password',
    placeholder: '••••••••••••',
    required: true,
  }) as HTMLInputElement;

  const submit = el('button', { class: 'auth-btn', type: 'submit' }, ['Sign in']);


  // A <form>, not a bare button: it is what makes Enter submit from either
  // field, and what lets a password manager recognise the pair and offer to
  // fill it. Both are free, and both are missed by a div-and-click-handler.
  const form = el('form', {
    class: 'auth-form',
    novalidate: true,
    onsubmit: (e: Event) => {
      e.preventDefault();
      clearError();
      const address = email.value.trim();
      if (!address || !password.value) {
        showError('Enter your email and password.');
        (address ? password : email).focus();
        return;
      }
      submit.setAttribute('disabled', 'true');
      submit.textContent = 'Signing in…';
      void signInWithPassword(address, password.value)
        // On success the app re-boots into the shell via AUTH_EVENT; this
        // screen is replaced, so there is nothing to reset.
        .catch((err: Error) => {
          submit.removeAttribute('disabled');
          submit.textContent = 'Sign in';
          showError(err.message);
          password.select();
        });
    },
  }, [
    el('label', { class: 'auth-label', for: 'auth-email' }, ['Email']),
    email,
    el('label', { class: 'auth-label', for: 'auth-password' }, ['Password']),
    password,
    submit,
    note,
  ]);

  const card = el('div', { class: 'auth-card' }, [
    el('div', { class: 'auth-brand' }, [
      el('span', { class: 'auth-mark', html: `<svg viewBox="0 0 24 24" fill="none">${ICONS.logo}</svg>` }),
      el('span', { class: 'auth-word' }, ['Engine']),
    ]),
    el('h1', { class: 'auth-title' }, ['Sign in']),
    el('p', { class: 'auth-sub' }, ['Your AI & search visibility — and the fixes that move it.']),
    form,
    el('p', { class: 'auth-foot' }, ['Invite-only access']),
  ]);

  root.append(el('div', { class: 'auth-screen' }, [el('div', { class: 'auth-center' }, [card])]));
  email.focus();
}
