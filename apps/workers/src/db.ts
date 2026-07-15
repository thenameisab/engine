import postgres from 'postgres';

/** Same factory shape as apps/api's — the edge worker reads Fix Queue state directly. */
export function createDb(connectionString: string) {
  return postgres(connectionString, { prepare: false });
}

export type Db = ReturnType<typeof createDb>;
