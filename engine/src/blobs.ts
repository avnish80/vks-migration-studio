import crypto from 'node:crypto';
import zlib from 'node:zlib';
import type { DB } from './db/index.js';

/** Stores a JSON document once, keyed by the SHA-256 of its serialised form. Returns the hash. */
export async function putBlob(db: DB, value: unknown): Promise<string> {
  const text = JSON.stringify(value);
  const hash = crypto.createHash('sha256').update(text).digest('hex');
  await db.insertInto('blobs').values({ hash, size: Buffer.byteLength(text), compressed: zlib.gzipSync(text), created_at: new Date().toISOString() })
    .onConflict(oc => oc.column('hash').doNothing()).execute();
  return hash;
}

export async function getBlob<T = unknown>(db: DB, hash: string): Promise<T> {
  const row = await db.selectFrom('blobs').select('compressed').where('hash', '=', hash).executeTakeFirstOrThrow();
  return JSON.parse(zlib.gunzipSync(row.compressed).toString('utf8')) as T;
}
