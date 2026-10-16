import fs from 'node:fs';
import path from 'node:path';
import SQLite from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import type { Database } from './schema.js';
import { provider } from './migrations.js';

export type DB = Kysely<Database>;

/** Opens (or creates) the store. Pass ':memory:' for tests. */
export function openDatabase(file: string): DB {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const sqlite = new SQLite(file);
  if (file !== ':memory:') for (const f of [file, file + '-wal', file + '-shm']) if (fs.existsSync(f)) fs.chmodSync(f, 0o600);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('recursive_triggers = ON');
  return new Kysely<Database>({ dialect: new SqliteDialect({ database: sqlite }) });
}

export async function migrate(db: DB): Promise<string[]> {
  const { error, results } = await new Migrator({ db, provider }).migrateToLatest();
  if (error) throw error;
  return (results ?? []).filter(r => r.status === 'Success').map(r => r.migrationName);
}
