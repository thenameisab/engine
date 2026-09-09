/**
 * Which Serper key a project's rank lookups run on.
 *
 * Serper was platform-owned: one key, ours, for every customer. Rank tracking
 * is priced per lookup, so that made the number of keywords all customers
 * together could track a cost decision of ours rather than theirs. It is now a
 * connectable provider, and this is the one place that decides whose key pays.
 *
 * The customer's key wins. The platform key is the fallback, so a customer who
 * has pasted nothing keeps working — same shape as the `GITHUB_TOKEN` fallback
 * on the deploy path. Any connection problem (not connected, revoked, a
 * cleared credential) falls back too: the Integrations screen is where a
 * broken connection is reported, and refusing the lookup would take the
 * feature away instead of telling anyone.
 */
import { getApiKeyCredential, ConnectionUnavailableError } from './integrations.js';
import type { Keyring } from '@engine/integrations';
import type { Db } from '../db.js';

export async function resolveSerpKey(
  db: Db,
  accountId: string,
  keyring: Keyring,
  env: { SERPER_API_KEY?: string },
): Promise<string | null> {
  try {
    const credential = await getApiKeyCredential(db, accountId, 'serper', keyring);
    const key = credential.secrets.apiKey;
    if (key) return key;
  } catch (err) {
    if (!(err instanceof ConnectionUnavailableError)) throw err;
  }
  return env.SERPER_API_KEY ?? null;
}
