import crypto from 'node:crypto';
import os from 'node:os';
import type { DB } from './db/index.js';
import { record } from './audit.js';

export type JobState = 'Queued' | 'Running' | 'Succeeded' | 'Failed';
export interface JobContext { id: string; payload: any; progress: (message: string) => Promise<void> }
export interface JobHandler { run: (ctx: JobContext) => Promise<unknown>; /** Safe to run again after a crash (read-only work). */ retryable: boolean; maxAttempts?: number }

/** A user-facing failure: the message is shown as is. Anything else becomes a generic message. */
export class JobFailure extends Error {}

const LEASE_MS = 60_000;

/**
 * In-process job queue persisted in SQLite (design 3.6). Jobs take a lease with a heartbeat; after an
 * engine crash, an expired lease is picked up again only for retryable jobs, otherwise the job fails
 * with a message asking for review. No external broker.
 */
export class JobRunner {
  private readonly owner = `${os.hostname()}:${process.pid}:${crypto.randomUUID().slice(0, 8)}`;
  private timer?: NodeJS.Timeout;
  private busy = false;
  private stopped = false;

  constructor(private db: DB, private handlers: Record<string, JobHandler>, private pollMs = 500) {}

  async enqueue(type: string, payload: unknown, projectId: string | null = null): Promise<string> {
    if (!this.handlers[type]) throw new Error(`Unknown job type ${type}`);
    const now = new Date().toISOString(), id = crypto.randomUUID();
    await this.db.insertInto('jobs').values({ id, type, project_id: projectId, payload: JSON.stringify(payload), state: 'Queued', attempts: 0, lease_owner: null, lease_until: null, progress: null, result: null, error: null, created_at: now, updated_at: now }).execute();
    this.kick();
    return id;
  }

  start(): void { this.stopped = false; this.timer = setInterval(() => this.kick(), this.pollMs); this.kick(); }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    while (this.busy) await new Promise(r => setTimeout(r, 20));
  }

  /** Runs queued jobs until none are left. Tests call this directly. */
  async drain(): Promise<void> { while (await this.runOne()); }

  private kick(): void {
    if (this.busy || this.stopped) return;
    this.busy = true;
    this.drain().catch(() => undefined).finally(() => { this.busy = false; });
  }

  private async claim(): Promise<{ id: string; type: string; payload: string; attempts: number } | undefined> {
    const now = new Date();
    return this.db.transaction().execute(async trx => {
      // Expired leases belong to a crashed engine.
      const stale = await trx.selectFrom('jobs').select(['id', 'type', 'attempts']).where('state', '=', 'Running').where('lease_until', '<', now.toISOString()).execute();
      for (const job of stale) {
        const handler = this.handlers[job.type];
        const retry = handler?.retryable && job.attempts < (handler.maxAttempts ?? 3);
        await trx.updateTable('jobs').set(retry
          ? { state: 'Queued', lease_owner: null, lease_until: null, updated_at: now.toISOString() }
          : { state: 'Failed', error: 'The engine stopped while this job was running. Review the target before running it again.', lease_owner: null, lease_until: null, updated_at: now.toISOString() }).where('id', '=', job.id).execute();
      }
      const next = await trx.selectFrom('jobs').select(['id', 'type', 'payload', 'attempts']).where('state', '=', 'Queued').orderBy('created_at').limit(1).executeTakeFirst();
      if (!next) return undefined;
      await trx.updateTable('jobs').set({ state: 'Running', attempts: next.attempts + 1, lease_owner: this.owner, lease_until: new Date(now.getTime() + LEASE_MS).toISOString(), updated_at: now.toISOString() }).where('id', '=', next.id).where('state', '=', 'Queued').execute();
      return next;
    });
  }

  private async runOne(): Promise<boolean> {
    if (this.stopped) return false;
    const job = await this.claim();
    if (!job) return false;
    const handler = this.handlers[job.type]!;
    const heartbeat = setInterval(() => {
      void this.db.updateTable('jobs').set({ lease_until: new Date(Date.now() + LEASE_MS).toISOString() }).where('id', '=', job.id).where('lease_owner', '=', this.owner).execute();
    }, LEASE_MS / 3);
    try {
      const result = await handler.run({
        id: job.id,
        payload: JSON.parse(job.payload),
        progress: async message => { await this.db.updateTable('jobs').set({ progress: message, updated_at: new Date().toISOString() }).where('id', '=', job.id).execute(); },
      });
      await this.finish(job.id, 'Succeeded', { result: JSON.stringify(result ?? null) });
      await record(this.db, `job.${job.type}.succeeded`, `job/${job.id}`);
    } catch (error) {
      const message = error instanceof JobFailure ? error.message : 'The job failed unexpectedly; see the engine log.';
      if (!(error instanceof JobFailure)) console.error(error);
      await this.finish(job.id, 'Failed', { error: message });
      await record(this.db, `job.${job.type}.failed`, `job/${job.id}`, { error: message });
    } finally {
      clearInterval(heartbeat);
    }
    return true;
  }

  private async finish(id: string, state: JobState, fields: { result?: string; error?: string }): Promise<void> {
    await this.db.updateTable('jobs').set({ state, ...fields, lease_owner: null, lease_until: null, updated_at: new Date().toISOString() }).where('id', '=', id).where('lease_owner', '=', this.owner).execute();
  }
}

export interface JobView { id: string; type: string; projectId: string | null; state: string; attempts: number; progress: string | null; result: unknown; error: string | null; createdAt: string; updatedAt: string }
export function jobView(j: { id: string; type: string; project_id: string | null; state: string; attempts: number; progress: string | null; result: string | null; error: string | null; created_at: string; updated_at: string }): JobView {
  return { id: j.id, type: j.type, projectId: j.project_id, state: j.state, attempts: j.attempts, progress: j.progress, result: j.result ? JSON.parse(j.result) : null, error: j.error, createdAt: j.created_at, updatedAt: j.updated_at };
}
