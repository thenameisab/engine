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

/**
 * Bind a value to a `jsonb` column.
 *
 * Always use this instead of `${JSON.stringify(value)}::jsonb`: the cast makes
 * Postgres infer the parameter as jsonb, so the driver JSON-encodes the string
 * we already encoded and the column ends up holding a jsonb *string* — objects
 * still read back through the same repository, but `col->>'key'` is null and
 * jsonb queries match nothing.
 *
 * The cast exists because postgres.js' `JSONValue` requires index signatures
 * that our domain interfaces (Action, Diff, DeployTarget, …) deliberately don't
 * carry. Anything we persist is plain JSON-serializable data by construction.
 */
export function toJsonb(db: Db, value: unknown) {
  return db.json(value as Parameters<Db['json']>[0]);
}
