-- Server-side state for an in-flight OAuth consent, so PKCE has somewhere to
-- keep its verifier and a `state` can be spent exactly once.
--
-- The signed state from `packages/auth/src/oauthState.ts` proves a callback
-- belongs to a flow we started. It cannot hold the PKCE verifier: a state
-- travels in a query string, through the customer's browser, into Google's
-- logs and back — and a verifier that is visible alongside the code it protects
-- protects nothing. HMAC signing makes the state unforgeable, not secret.
--
-- So the verifier stays here, on the server, joined to the flow by the state's
-- nonce. Sealed at rest with the same keyring as a stored credential, because
-- for the ten minutes a flow is live the verifier is exactly as sensitive as
-- one: possession of it plus a stolen code yields a live grant.
--
-- The second thing this buys is replay. A signed state is currently reusable
-- until it expires — ten minutes in which a captured callback URL can be
-- replayed. `consumed_at` closes that: the callback claims the row atomically,
-- and a second arrival finds nothing to claim.
create table oauth_flows (
  -- The nonce from the signed state. Primary key rather than a surrogate id:
  -- the uniqueness is the point, and it makes the claim a single UPDATE.
  nonce text primary key,

  account_id uuid not null references accounts(id) on delete cascade,
  provider text not null,
  -- Not a FK to users: the row is short-lived and an offboarding mid-flow must
  -- not delete the flow out from under a callback that is already in flight.
  user_id text not null,

  -- 'v1.<iv>.<ciphertext>' — packages/auth/src/secretBox.ts, with the account
  -- and provider bound in as AAD exactly as a credential's is.
  code_verifier_sealed text not null,
  key_version text not null default 'v1',

  -- Where to send the browser afterwards. Validated against the configured
  -- dashboard origin at callback time; stored verbatim so that check happens in
  -- one place rather than at both ends of the flow.
  return_to text,

  created_at timestamptz not null default now(),
  -- Matches the signed state's own TTL. Both are checked: the state's expiry
  -- is authoritative for "is this link stale", and this one makes sure a row
  -- whose state was never presented is still reapable.
  expires_at timestamptz not null,
  -- Null until the callback claims it. Set, never deleted in the same
  -- statement, so a replay can be told apart from an unknown nonce.
  consumed_at timestamptz
);

-- The reaper's query: everything past its expiry that nobody claimed.
create index oauth_flows_expires_at_idx on oauth_flows(expires_at) where consumed_at is null;
