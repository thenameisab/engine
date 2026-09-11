/**
 * M2.5 agency white-label. `accounts`/`projects` (0001_init.sql) always had
 * the 1-account-to-many-projects shape; these are the first typed contracts
 * for them, now that account/project creation and branding are real routes
 * instead of rows seeded straight into Postgres.
 */
export interface AccountBranding {
  companyName?: string;
  logoUrl?: string;
  primaryColor?: string;
}

/**
 * What kind of thing an account is. Onboarding asks it and 0035 stores it; the
 * dashboard reads it to decide whether to speak about "clients" at all and
 * whether to offer the white-label branding panel.
 */
export const ACCOUNT_KINDS = ['company', 'agency', 'individual'] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];

export interface Account {
  id: string;
  name: string;
  kind: AccountKind;
  branding: AccountBranding;
  createdAt: string;
}

export interface Project {
  id: string;
  accountId: string;
  name: string;
  domain: string;
  createdAt: string;
}
