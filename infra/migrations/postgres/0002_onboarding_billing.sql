-- E onboarding activation + G billing (M1.6/M1.7). Mirrors
-- packages/core/src/onboarding.ts OnboardingProgress and
-- packages/core/src/billing.ts Subscription.

-- One row per project, milestones set once on first occurrence — this is the
-- KPI instrumentation the roadmap's exit criteria depend on: time from
-- domain_connected_at to first_insight_at (E2, target <10 min) and to
-- first_fix_proposed_at (E3, target <48h).
create table onboarding_progress (
  project_id uuid primary key references projects(id) on delete cascade,
  domain_connected_at timestamptz,
  gsc_connected_at timestamptz,
  first_crawl_at timestamptz,
  first_insight_at timestamptz,
  first_fix_proposed_at timestamptz,
  first_fix_deployed_at timestamptz
);

-- One row per account. Stripe is the source of truth; this is a synced read
-- model updated from the webhook handler (packages/billing).
create table subscriptions (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  plan_tier text not null default 'starter' check (plan_tier in ('starter', 'growth', 'agency', 'enterprise')),
  status text not null default 'incomplete'
    check (status in ('trialing', 'active', 'past_due', 'canceled', 'incomplete')),
  stripe_customer_id text not null,
  stripe_subscription_id text,
  current_period_end timestamptz,
  updated_at timestamptz not null default now(),
  unique (account_id),
  unique (stripe_customer_id)
);

create index subscriptions_account_id_idx on subscriptions(account_id);
