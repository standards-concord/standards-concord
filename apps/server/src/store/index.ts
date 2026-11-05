import path from 'node:path';
import { config } from '../config.js';
import { nodePostgresDriver, pgliteDriver } from './drivers.js';
import { PostgresStore } from './postgres.js';
import { SqliteStore } from './sqlite.js';
import type { DocStore } from './types.js';

export type { DocStore } from './types.js';
export { StoreBusyError } from './types.js';

export type StoreOptions =
  | { kind: 'sqlite'; file?: string }
  | { kind: 'postgres'; url: string; max?: number }
  /** In-process Postgres; no `dataDir` keeps it in memory. */
  | { kind: 'pglite'; dataDir?: string };

/**
 * Which store the environment asks for:
 * - `DATABASE_URL` (or `POSTGRES_URL`), as Neon's Vercel integration sets them: Postgres.
 * - `CONCORD_STORE=pglite`: in-process Postgres under the data directory.
 * - Otherwise SQLite under the data directory, as today.
 */
export function storeOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): StoreOptions {
  const url = env.DATABASE_URL ?? env.POSTGRES_URL;
  if (url) return { kind: 'postgres', url };
  if (env.CONCORD_STORE === 'pglite') return { kind: 'pglite', dataDir: path.join(config.dataDir, 'pglite') };
  return { kind: 'sqlite' };
}

export async function openStore(opts: StoreOptions = storeOptionsFromEnv()): Promise<DocStore> {
  switch (opts.kind) {
    case 'sqlite':
      return SqliteStore.open(opts.file ?? path.join(config.dataDir, 'concord.sqlite'));
    case 'postgres':
      return PostgresStore.open(await nodePostgresDriver(opts.url, { max: opts.max }));
    case 'pglite':
      return PostgresStore.open(await pgliteDriver(opts.dataDir));
  }
}
