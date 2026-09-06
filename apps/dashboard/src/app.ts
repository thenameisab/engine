import { mountShell } from './shell.js';
import { mountAuthScreen } from './auth/authScreen.js';
import { isAuthenticated, AUTH_EVENT } from './auth/session.js';

const root = document.getElementById('root');

/**
 * Render whichever half of the app the session calls for, and re-render on
 * `AUTH_EVENT` so signing in or out swaps them without a reload.
 *
 * Both `mountShell` and `mountAuthScreen` clear the root rather than appending
 * to it. That symmetry is the whole fix for the old post-sign-in hang, where
 * the shell mounted *underneath* a still-present full-viewport auth screen and
 * only a reload appeared to help.
 *
 * The boot-time `fetchRemoteSession()` that used to adopt a returning OAuth
 * cookie is gone with the Google button: nothing can start that redirect now,
 * so the call could only ever come back empty. `neonAuth.ts` still holds the
 * flow for when the deployed origin is added to Neon Auth's trusted origins.
 */
function boot(): void {
  if (!root) return;
  if (isAuthenticated()) mountShell(root);
  else mountAuthScreen(root);
}

addEventListener(AUTH_EVENT, boot);
boot();
