import postgres from 'postgres';

/**
 * Postgres client factory (Architecture §2.3: Workers orchestrate, the
 * stateful warehouse runs off-edge — Neon/Supabase/RDS behind Hyperdrive).
 * Connection string is bound as a Worker secret/env var, never hardcoded.
 */
export function createDb(connectionString: string) {
  return postgres(connectionString, { prepare: false });
}

export type Db = ReturnType<typeof createDb>;
