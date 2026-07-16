import { mountShell } from './shell.js';
import { mountAuthScreen } from './auth/authScreen.js';
import { isAuthenticated, setSession, AUTH_EVENT } from './auth/session.js';
import { fetchRemoteSession } from './auth/neonAuth.js';

const root = document.getElementById('root');

function boot(): void {
  if (!root) return;
  if (isAuthenticated()) {
    mountShell(root);
    return;
  }
  mountAuthScreen(root);
  // If we just returned from an OAuth redirect, adopt the Better Auth cookie
  // session — setSession fires AUTH_EVENT, which re-boots into the shell.
  void fetchRemoteSession().then((u) => {
    if (u && !isAuthenticated()) setSession(u);
  });
}

addEventListener(AUTH_EVENT, boot);
boot();
