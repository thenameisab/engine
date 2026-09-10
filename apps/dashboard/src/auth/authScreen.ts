import { el } from '../dom.js';
import { ICONS } from '../icons.js';
import { signInWithPassword } from './passwordAuth.js';
import { requestSignInCode, verifySignInCode } from './codeAuth.js';

/**
 * The sign-in screen. Email first; then either a one-time code sent to that
 * address (the default) or a password (the alternative, one click away).
 *
 * Code first because it is the path that needs nothing set up: an invited
 * person has an address and nothing else, and a person who forgot a password
 * has the same. A password is what you choose later, in Settings, if you want
 * a sign-in that does not wait on an inbox.
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
type Mode = 'code-request' | 'code-verify' | 'password';

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

  // `one-time-code` is what lets iOS and Android offer the code straight from
  // the mail notification; `inputmode` gives a numeric keypad on a phone.
  const code = el('input', {
    class: 'auth-field',
    type: 'text',
    name: 'code',
    id: 'auth-code',
    autocomplete: 'one-time-code',
    inputmode: 'numeric',
    pattern: '[0-9]{6}',
    maxlength: '6',
    placeholder: '6-digit code',
    required: true,
  }) as HTMLInputElement;

  const submit = el('button', { class: 'auth-btn', type: 'submit' }, ['Email me a code']);
  const passwordLabel = el('label', { class: 'auth-label', for: 'auth-password' }, ['Password']);
  const codeLabel = el('label', { class: 'auth-label', for: 'auth-code' }, ['Code']);
  const sentTo = el('p', { class: 'auth-sub' });
  const toggle = el('button', { class: 'auth-alt', type: 'button' }, ['Use a password instead']);

  let mode: Mode = 'code-request';
  let busy = false;

  const setBusy = (on: boolean, label: string) => {
    busy = on;
    if (on) submit.setAttribute('disabled', 'true');
    else submit.removeAttribute('disabled');
    submit.textContent = label;
  };

  const render = () => {
    clearError();
    const inCode = mode === 'code-verify';
    const inPassword = mode === 'password';
    email.hidden = inCode;
    for (const node of [passwordLabel, password]) node.hidden = !inPassword;
    for (const node of [codeLabel, code, sentTo]) node.hidden = !inCode;
    password.required = inPassword;
    code.required = inCode;
    sentTo.textContent = inCode ? `We sent a code to ${email.value.trim()}. It expires in 10 minutes.` : '';
    submit.textContent = inCode ? 'Sign in' : inPassword ? 'Sign in' : 'Email me a code';
    toggle.textContent = inCode ? 'Use a different email' : inPassword ? 'Email me a code instead' : 'Use a password instead';
    (inCode ? code : inPassword && email.value ? password : email).focus();
  };

  toggle.addEventListener('click', () => {
    mode = mode === 'password' ? 'code-request' : mode === 'code-verify' ? 'code-request' : 'password';
    code.value = '';
    render();
  });

  // A <form>, not a bare button: it is what makes Enter submit from any field,
  // and what lets a password manager recognise the email/password pair and
  // offer to fill it. Both are free, and both are missed by a div-and-click.
  const form = el('form', {
    class: 'auth-form',
    novalidate: true,
    onsubmit: (e: Event) => {
      e.preventDefault();
      if (busy) return;
      clearError();
      const address = email.value.trim();
      if (!address) {
        showError('Enter your email.');
        email.focus();
        return;
      }
      if (mode === 'code-request') {
        setBusy(true, 'Sending…');
        void requestSignInCode(address)
          .then(() => {
            mode = 'code-verify';
            setBusy(false, 'Sign in');
            render();
          })
          .catch((err: Error) => {
            setBusy(false, 'Email me a code');
            showError(err.message);
          });
        return;
      }
      if (mode === 'code-verify') {
        const digits = code.value.replace(/\D/g, '');
        if (digits.length !== 6) {
          showError('Enter the 6-digit code from the email.');
          code.focus();
          return;
        }
        setBusy(true, 'Signing in…');
        // On success the app re-boots into the shell via AUTH_EVENT; this
        // screen is replaced, so there is nothing to reset.
        void verifySignInCode(address, digits).catch((err: Error) => {
          setBusy(false, 'Sign in');
          showError(err.message);
          code.select();
        });
        return;
      }
      if (!password.value) {
        showError('Enter your password.');
        password.focus();
        return;
      }
      setBusy(true, 'Signing in…');
      void signInWithPassword(address, password.value).catch((err: Error) => {
        setBusy(false, 'Sign in');
        showError(err.message);
        password.select();
      });
    },
  }, [
    el('label', { class: 'auth-label', for: 'auth-email' }, ['Email']),
    email,
    sentTo,
    codeLabel,
    code,
    passwordLabel,
    password,
    submit,
    note,
    toggle,
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
  render();
}
