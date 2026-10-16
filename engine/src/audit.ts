import type { DB } from './db/index.js';

export async function record(db: DB, action: string, subject: string, detail: Record<string, unknown> = {}, actor = 'local-user'): Promise<void> {
  await db.insertInto('audit').values({ at: new Date().toISOString(), actor, action, subject, detail: JSON.stringify(detail) }).execute();
}
