import { mountShell } from './shell.js';
import { mountAuthScreen } from './auth/authScreen.js';
import { isAuthenticated, AUTH_EVENT } from './auth/session.js';

const root = document.getElementById('root');

function boot(): void {
  if (!root) return;
  root.replaceChildren();
  if (isAuthenticated()) mountShell(root);
  else mountAuthScreen(root);
}

// Re-boot whenever auth state flips (sign in / sign out).
addEventListener(AUTH_EVENT, boot);
boot();
