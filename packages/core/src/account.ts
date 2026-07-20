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

export interface Account {
  id: string;
  name: string;
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
