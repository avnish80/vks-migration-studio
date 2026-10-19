import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './config.js';
import type { Core } from './core.js';
import type { DB } from './db/index.js';
import { getBlob, putBlob } from './blobs.js';
import { record } from './audit.js';
import { JobFailure, type JobHandler } from './jobs.js';
import { kubeEnv } from './kube.js';
import { inventoryClusterUid } from './inventory.js';

/*
 * Engine-run pilots (design section 3.7, phase 1a): the engine plans with the reused execution module
 * and runs each step with the existing, tested dist/pilot-runner.py, recording every receipt as
 * evidence. The runner keeps all of its own safety checks; the engine adds persistent state, one
 * unresolved run per workload, and confirmations captured in the UI.
 */

export type Step = 'validate' | 'deploy' | 'observe' | 'inspect' | 'cleanup';
export type RunState =
  | 'Validating' | 'Validated' | 'ValidationFailed'
  | 'Deploying' | 'PilotPassed' | 'NothingCreated' | 'NeedsRecovery'
  | 'Observing' | 'Inspecting' | 'Inspected' | 'Cleaning' | 'CleanupPending'
  | 'NeedsReview' | 'Cleaned' | 'Absent' | 'Discarded';

export const CLOSED: RunState[] = ['Cleaned', 'Absent', 'Discarded', 'ValidationFailed', 'NothingCreated'];
const BUSY: Partial<Record<Step, RunState>> = { validate: 'Validating', deploy: 'Deploying', observe: 'Observing', inspect: 'Inspecting', cleanup: 'Cleaning' };

/** Which steps a run may take next, by state. */
export const ACTIONS: Record<RunState, (Step | 'discard')[]> = {
  Validating: [], Deploying: [], Observing: [], Inspecting: [], Cleaning: [],
  Validated: ['deploy', 'validate', 'discard'],
  ValidationFailed: [], NothingCreated: [], Cleaned: [], Absent: [], Discarded: [],
  PilotPassed: ['observe', 'inspect'],
  NeedsRecovery: ['inspect'],
  NeedsReview: ['inspect'],
  Inspected: ['cleanup', 'inspect', 'observe'],
  CleanupPending: ['inspect'],
};

export class PilotError extends Error { constructor(public status: number, message: string) { super(message); } }

const VALIDATION_MAX_AGE_MS = 25 * 60_000;   // the runner accepts 30 minutes
const INSPECTION_MAX_AGE_MS = 9 * 60_000;    // the runner accepts 10 minutes

export interface PlanOptions { serviceAccount?: string; images?: Record<string, string>; settings?: Record<string, unknown> }

const exec = (c: Core) => c.modules.execution as { plan: (raw: unknown, target: unknown, options: unknown) => { workload: string; blockers: { resource: string; reason: string }[]; prerequisites: unknown[]; settings: unknown; preflight: { manifests: { items: unknown[] }; checks: unknown[] }; planRevision: string } };

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(value);
}

/**
 * Builds a pilot plan for one workload from the project's latest source and target snapshots. The
 * plan's revision is a hash of exactly the inputs it depends on (design 3.4): editing anything else in
 * the project never invalidates it.
 */
export async function createPlan(db: DB, core: Core, projectId: string, workloadId: string, options: PlanOptions) {
  const workload = await db.selectFrom('workloads').selectAll().where('id', '=', workloadId).where('project_id', '=', projectId).executeTakeFirst();
  if (!workload) throw new PilotError(404, 'No workload with that id.');
  const project = await db.selectFrom('projects').selectAll().where('id', '=', projectId).executeTakeFirstOrThrow();
  if (!project.target_cluster_id) throw new PilotError(400, 'Choose a VKS target cluster for this project first.');
  const target = await db.selectFrom('clusters').selectAll().where('id', '=', project.target_cluster_id).executeTakeFirstOrThrow();
  if (!target.pilot_context_name) throw new PilotError(400, 'The target cluster has no pilot login. Add one on the Clusters page.');
  const latest = (side: 'source' | 'target') => db.selectFrom('snapshots').selectAll().where('project_id', '=', projectId).where('side', '=', side).orderBy('stored_at', 'desc').orderBy('id', 'desc').limit(1).executeTakeFirst();
  const [srcSnap, tgtSnap] = [await latest('source'), await latest('target')];
  if (!srcSnap) throw new PilotError(400, 'Collect or import a source inventory first.');
  if (!tgtSnap) throw new PilotError(400, 'Collect the target cluster inventory first: the plan checks names and APIs against it.');
  const [source, targetInv] = [await getBlob(db, srcSnap.blob_hash), await getBlob(db, tgtSnap.blob_hash)];
  const targetUid = inventoryClusterUid(targetInv as never);
  if (targetUid && target.observed_uid && targetUid !== target.observed_uid) throw new PilotError(400, 'The latest target inventory is from a different cluster than the project target. Collect the target again.');

  const inputs = { workload: workload.resource_id, source: srcSnap.blob_hash, target: tgtSnap.blob_hash, context: target.pilot_context_name, targetUid: target.observed_uid, serviceAccount: options.serviceAccount ?? '', images: options.images ?? {}, settings: options.settings ?? {} };
  const inputHash = crypto.createHash('sha256').update(canonical(inputs)).digest('hex');
  let plan;
  try {
    plan = exec(core).plan(source, targetInv, { revision: inputHash, context: target.pilot_context_name, settings: options.settings ?? {}, pilot: { workload: workload.resource_id, serviceAccount: options.serviceAccount, images: options.images ?? {} } });
  } catch (e) { throw new PilotError(400, e instanceof Error ? e.message : 'Could not build a plan.'); }
  const blob = await putBlob(db, plan);
  const id = crypto.randomUUID(), now = new Date().toISOString();
  await db.transaction().execute(async trx => {
    await trx.insertInto('plans').values({ id, workload_id: workload.id, project_id: projectId, input_hash: inputHash, blob_hash: blob, settings: JSON.stringify(inputs), blockers: plan.blockers.length, source_snapshot_id: srcSnap.id, target_snapshot_id: tgtSnap.id, created_at: now }).execute();
    if (['Assessed', 'Planned', 'Blocked'].includes(workload.state) && !plan.blockers.length) await trx.updateTable('workloads').set({ state: 'Planned', updated_at: now }).where('id', '=', workload.id).execute();
    await record(trx as unknown as DB, 'pilot.plan', `workload/${workload.id}`, { plan: id, inputHash, blockers: plan.blockers.length });
  });
  return planView({ id, workload_id: workload.id, input_hash: inputHash, created_at: now, blockers: plan.blockers.length }, plan);
}

export function planView(row: { id: string; workload_id: string; input_hash: string; created_at: string; blockers: number }, plan: ReturnType<ReturnType<typeof exec>['plan']>) {
  return { id: row.id, workloadId: row.workload_id, workload: plan.workload, revision: row.input_hash, createdAt: row.created_at, blockers: plan.blockers, prerequisites: plan.prerequisites, settings: plan.settings, manifests: plan.preflight.manifests, checks: plan.preflight.checks };
}

// ---- runs ----------------------------------------------------------------------------------

export function runDir(config: Config, runId: string): string {
  const dir = path.join(config.dataDir, 'runs', runId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

async function setRun(db: DB, runId: string, state: RunState, detail: string | null) {
  await db.updateTable('runs').set({ state, status_detail: detail, updated_at: new Date().toISOString() }).where('id', '=', runId).execute();
}

/** Workload lifecycle follows its runs; assessment never overwrites these states. */
async function syncWorkload(db: DB, workloadId: string) {
  // The latest run that got past validation decides: an earlier pass does not outlive a later failure.
  const latest = await db.selectFrom('runs').select(['id', 'state']).where('workload_id', '=', workloadId).where('state', 'not in', ['Discarded', 'ValidationFailed']).orderBy('created_at', 'desc').orderBy('id', 'desc').limit(1).executeTakeFirst();
  let state = 'Planned';
  if (latest) {
    const last = await db.selectFrom('evidence').select('kind').where('run_id', '=', latest.id).where(eb => eb.or([eb('kind', 'like', 'deploy:%'), eb('kind', 'like', 'observe:%')])).orderBy('observed_at', 'desc').orderBy('id', 'desc').limit(1).executeTakeFirst();
    const passed = last?.kind === 'deploy:Passed' || last?.kind === 'observe:Passed';
    const open = !CLOSED.includes(latest.state as RunState);
    state = passed ? 'PilotPassed' : open ? 'Piloting' : 'PilotFailed';
  }
  await db.updateTable('workloads').set({ state, updated_at: new Date().toISOString() }).where('id', '=', workloadId).where('state', 'in', ['Assessed', 'Planned', 'Blocked', 'Piloting', 'PilotPassed', 'PilotFailed']).execute();
}

/** A plan names a pilot login and a cluster; both must still be the project's current target. */
async function assertPlanTarget(db: DB, plan: { project_id: string | null; settings: string | null }) {
  const inputs = (plan.settings ? JSON.parse(plan.settings) : {}) as { context?: string; targetUid?: string };
  const project = plan.project_id ? await db.selectFrom('projects').select('target_cluster_id').where('id', '=', plan.project_id).executeTakeFirst() : undefined;
  const target = project?.target_cluster_id ? await db.selectFrom('clusters').select(['pilot_context_name', 'observed_uid', 'retired_at']).where('id', '=', project.target_cluster_id).executeTakeFirst() : undefined;
  if (!target || target.retired_at || target.pilot_context_name !== inputs.context || target.observed_uid !== inputs.targetUid) {
    throw new PilotError(409, "The project's target cluster or its pilot login changed after this plan was made. Create a new plan.");
  }
}

export async function startRun(db: DB, planId: string, acknowledgePrerequisites: boolean): Promise<string> {
  const plan = await db.selectFrom('plans').selectAll().where('id', '=', planId).executeTakeFirst();
  if (!plan) throw new PilotError(404, 'No plan with that id.');
  if (plan.blockers) throw new PilotError(400, 'This plan has blockers. Resolve them and create a new plan.');
  if (!acknowledgePrerequisites) throw new PilotError(400, 'Confirm that the listed prerequisites are in place on the target.');
  const latest = await db.selectFrom('plans').select('id').where('workload_id', '=', plan.workload_id).orderBy('created_at', 'desc').limit(1).executeTakeFirst();
  if (latest?.id !== plan.id) throw new PilotError(409, 'A newer plan exists for this workload. Use the latest plan.');
  await assertPlanTarget(db, plan);
  const id = crypto.randomUUID(), now = new Date().toISOString();
  try {
    await db.insertInto('runs').values({ id, plan_id: plan.id, workload_id: plan.workload_id, project_id: plan.project_id, run_label: id, state: 'Validating', status_detail: null, lease_owner: null, heartbeat_at: null, created_at: now, updated_at: now }).execute();
  } catch (e) {
    if (/UNIQUE/.test(String(e))) throw new PilotError(409, 'This workload has an unresolved pilot run. Finish or clean it up first.');
    throw e;
  }
  await record(db, 'pilot.run.start', `run/${id}`, { plan: plan.id, acknowledgedPrerequisites: true });
  await syncWorkload(db, plan.workload_id);
  return id;
}

interface Evidence { kind: string; report: Record<string, unknown>; observedAt: string }
async function lastEvidence(db: DB, runId: string, step: Step): Promise<Evidence | undefined> {
  const row = await db.selectFrom('evidence').selectAll().where('run_id', '=', runId).where('kind', 'like', `${step}:%`).orderBy('observed_at', 'desc').orderBy('id', 'desc').limit(1).executeTakeFirst();
  return row ? { kind: row.kind, report: await getBlob(db, row.blob_hash), observedAt: row.observed_at } : undefined;
}

export interface StepRequest { confirmWorkload?: string; confirmRun?: string; acknowledgeExternalState?: boolean }

/** Checks a requested step against the run's state and the user's confirmations, then marks it busy. */
export async function requestStep(db: DB, runId: string, step: Step | 'discard', body: StepRequest) {
  const run = await db.selectFrom('runs').selectAll().where('id', '=', runId).executeTakeFirst();
  if (!run) throw new PilotError(404, 'No run with that id.');
  const state = run.state as RunState;
  if (!ACTIONS[state]?.includes(step)) throw new PilotError(409, `A run in state ${state} cannot ${step}.`);
  const plan = await db.selectFrom('plans').select(['blob_hash', 'project_id', 'settings']).where('id', '=', run.plan_id).executeTakeFirstOrThrow();
  const workload = (await getBlob<{ workload: string }>(db, plan.blob_hash)).workload;
  if (step === 'deploy') {
    await assertPlanTarget(db, plan);
    if (body.confirmWorkload !== workload) throw new PilotError(400, `Type the workload name exactly (${workload}) to confirm the deployment.`);
    const v = await lastEvidence(db, runId, 'validate');
    if (!v || v.kind !== 'validate:Passed' || Date.now() - Date.parse(v.observedAt) > VALIDATION_MAX_AGE_MS) throw new PilotError(409, 'The last validation is missing, failed or older than 25 minutes. Validate again.');
  }
  if (step === 'cleanup') {
    if (body.confirmRun !== run.run_label) throw new PilotError(400, 'Type the run ID exactly to confirm the clean-up.');
    if (!body.acknowledgeExternalState) throw new PilotError(400, 'Confirm that external effects (data written, messages sent) have been reviewed with the owner.');
    const i = await lastEvidence(db, runId, 'inspect');
    if (!i || !['inspect:ReviewRequired', 'inspect:Absent'].includes(i.kind) || Date.now() - Date.parse(i.observedAt) > INSPECTION_MAX_AGE_MS) throw new PilotError(409, 'Clean-up needs an inspection from the last 9 minutes. Inspect again.');
  }
  if (step === 'discard') {
    const discarded = await db.updateTable('runs').set({ state: 'Discarded', status_detail: 'Discarded before deployment; nothing was created.', updated_at: new Date().toISOString() }).where('id', '=', runId).where('state', '=', state).executeTakeFirst();
    if (discarded.numUpdatedRows !== 1n) throw new PilotError(409, 'The run changed meanwhile. Reload and try again.');
    await record(db, 'pilot.run.discard', `run/${runId}`);
    await syncWorkload(db, run.workload_id);
    return;
  }
  const busy = BUSY[step]!;
  const moved = await db.updateTable('runs').set({ state: busy, status_detail: null, updated_at: new Date().toISOString() }).where('id', '=', runId).where('state', '=', state).executeTakeFirst();
  if (moved.numUpdatedRows !== 1n) throw new PilotError(409, 'The run changed meanwhile. Reload and try again.');
  await record(db, `pilot.${step}.request`, `run/${runId}`, step === 'cleanup' ? { acknowledgedExternalState: true } : step === 'deploy' ? { confirmedWorkload: workload } : {});
}

/** Moves the run to its next state from a runner receipt. */
export function nextState(step: Step, report: Record<string, unknown>): RunState {
  const status = String(report.status);
  switch (step) {
    case 'validate': return status === 'Passed' ? 'Validated' : 'ValidationFailed';
    case 'deploy': {
      if (status === 'Passed') return 'PilotPassed';
      const left = (Array.isArray(report.created) ? report.created.length : 0) + (Array.isArray(report.uncertain) ? report.uncertain.length : 0);
      return left ? 'NeedsRecovery' : 'NothingCreated';
    }
    case 'observe': return status === 'Passed' ? 'PilotPassed' : 'NeedsRecovery';
    case 'inspect': return status === 'Absent' ? 'Absent' : status === 'ReviewRequired' ? 'Inspected' : 'NeedsReview';
    case 'cleanup': return status === 'Absent' ? 'Cleaned' : status === 'Pending' ? 'CleanupPending' : 'NeedsReview';
  }
}

function runRunner(config: Config, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(config.python, ['-I', '-B', path.join(config.coreDir, 'pilot-runner.py'), ...args], { env: kubeEnv(config), timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, error => {
      const e = error as (NodeJS.ErrnoException & { killed?: boolean }) | null;
      if (e?.code === 'ENOENT') return reject(new JobFailure('Python 3 is not installed where the engine runs.'));
      if (e?.killed) return reject(new JobFailure('The pilot step took too long and was stopped. Inspect the target before anything else.'));
      resolve();   // a non-zero exit still writes a receipt, which decides the outcome
    });
  });
}

/** The deploy receipt, or the runner's partial receipt left in the run folder by an interrupted deploy. */
async function deployReceipt(db: DB, config: Config, runId: string): Promise<Record<string, unknown> | undefined> {
  const recorded = await lastEvidence(db, runId, 'deploy');
  if (recorded) return recorded.report;
  const file = path.join(runDir(config, runId), 'deploy.json');
  if (!fs.existsSync(file)) return undefined;
  try {
    const partial = JSON.parse(fs.readFileSync(file, 'utf8'));
    return partial && typeof partial === 'object' && partial.kind === 'PilotExecutionResult' ? partial : undefined;
  } catch { return undefined; }
}

export interface PilotOptions {
  /** After a clean-up whose deletions are still in progress, re-inspect this often… */
  cleanupPollMs: number;
  /** …for at most this long, before handing back to a manual inspection. */
  cleanupWaitMs: number;
}
const DEFAULT_OPTIONS: PilotOptions = { cleanupPollMs: 5_000, cleanupWaitMs: 2 * 60_000 };

/** Job handler: runs one pilot step with the runner and records its receipt. */
export function pilotHandler(db: DB, config: Config, options: PilotOptions = DEFAULT_OPTIONS): JobHandler {
  return {
    retryable: false,   // pilot steps write to a cluster: never repeated automatically
    async run({ id: jobId, payload, progress }) {
      const { runId, step, confirmWorkload, confirmRun } = payload as { runId: string; step: Step; confirmWorkload?: string; confirmRun?: string };
      const run = await db.selectFrom('runs').selectAll().where('id', '=', runId).executeTakeFirstOrThrow();
      // The request marked the run busy for this step; anything else means it changed since (and this job must not act).
      if (run.state !== BUSY[step]) throw new JobFailure(`The run is ${run.state}, not ready for ${step}; nothing was done.`);
      const plan = await db.selectFrom('plans').selectAll().where('id', '=', run.plan_id).executeTakeFirstOrThrow();
      const planDoc = await getBlob<Record<string, unknown> & { preflight: { expectedContext: string } }>(db, plan.blob_hash);
      const context = planDoc.preflight.expectedContext;
      const dir = runDir(config, runId);
      const n = (await db.selectFrom('evidence').select('id').where('run_id', '=', runId).execute()).length;
      const write = (name: string, value: unknown) => { const f = path.join(dir, name); fs.writeFileSync(f, JSON.stringify(value), { mode: 0o600 }); return f; };
      // Deploy happens once per run; other steps can repeat, and an interrupted attempt leaves its file behind.
      const output = path.join(dir, step === 'deploy' ? 'deploy.json' : `${String(n + 1).padStart(3, '0')}-${step}-${jobId.slice(0, 8)}.json`);
      if (fs.existsSync(output)) throw new JobFailure('A receipt for this step already exists. Inspect the run before continuing.');
      const planFile = write('plan.json', planDoc);
      const args = [step, '--context', context, '--plan', planFile, '--output', output];
      let receiptFile = '';
      try {
        if (step === 'deploy') {
          const v = await lastEvidence(db, runId, 'validate');
          args.push('--validation', write('validation.json', v?.report), '--confirm-workload', confirmWorkload ?? '', '--ack-prerequisites');
        }
        if (step === 'observe' || step === 'inspect' || step === 'cleanup') {
          const receipt = await deployReceipt(db, config, runId);
          if (!receipt) {
            // The runner writes its receipt (with the run label) before it creates anything on the target.
            await closeNothingCreated(db, runId, run.workload_id, 'The deploy never reached the target: there is no deploy receipt, and the runner records one before it creates anything.');
            return { step, status: 'NoReceipt', state: 'NothingCreated' };
          }
          // A partial receipt from an interrupted deploy also carries the label on the target objects.
          if (typeof receipt.runId === 'string' && /^[a-z0-9-]{1,80}$/.test(receipt.runId) && receipt.runId !== run.run_label) {
            await db.updateTable('runs').set({ run_label: receipt.runId }).where('id', '=', runId).execute();
          }
          receiptFile = write('receipt.json', receipt);
          args.push('--receipt', receiptFile);
        }
        if (step === 'cleanup') {
          const i = await lastEvidence(db, runId, 'inspect');
          args.push('--inspection', write('inspection.json', i?.report), '--confirm-run', confirmRun ?? '', '--ack-external-state');
        }
        await progress({ validate: 'Validating against the target (read-only checks and a server-side dry run)', deploy: 'Deploying the pilot and waiting for it to become ready', observe: 'Re-checking the pilot and repeating the smoke test', inspect: 'Inspecting the pilot objects on the target', cleanup: 'Deleting the pilot objects with UID preconditions' }[step]);
        await runRunner(config, args, ((planDoc.settings as { rolloutSeconds?: number })?.rolloutSeconds ?? 180) * 1000 + 15 * 60_000);
        let report: Record<string, unknown>;
        try { report = JSON.parse(fs.readFileSync(output, 'utf8')); } catch { throw new JobFailure('The pilot runner wrote no readable receipt. Inspect the target before anything else.'); }
        const status = String(report.status ?? 'Unknown');
        let state = nextState(step, report);
        // After a clean-up, an inspection that finds nothing left closes the run as Cleaned.
        if (step === 'inspect' && state === 'Absent' && (await lastEvidence(db, runId, 'cleanup'))) state = 'Cleaned';
        // Deletions requested but still finishing (foreground deletion waits for ReplicaSets and Pods):
        // the run stays busy while this job re-inspects, read-only, until they are gone.
        const settling = step === 'cleanup' && state === 'CleanupPending';
        const detail = typeof report.error === 'string' ? report.error.slice(0, 500) : null;
        // The runner labels the objects it creates with its own run ID; that is the ID operators
        // confirm for clean-up and see on the target, so the run adopts it once a deploy starts.
        const label = step === 'deploy' && typeof report.runId === 'string' && /^[a-z0-9-]{1,80}$/.test(report.runId) ? report.runId : undefined;
        await db.transaction().execute(async trx => {
          await trx.insertInto('evidence').values({ id: crypto.randomUUID(), run_id: runId, kind: `${step}:${status}`, input_hash: plan.input_hash, blob_hash: await putBlob(trx as unknown as DB, report), observed_at: new Date().toISOString() }).execute();
          await trx.updateTable('runs').set({ state: settling ? 'Cleaning' : state, status_detail: detail, updated_at: new Date().toISOString(), ...(label ? { run_label: label } : {}) }).where('id', '=', runId).execute();
          await record(trx as unknown as DB, `pilot.${step}.${status.toLowerCase()}`, `run/${runId}`, detail ? { detail } : {});
        });
        if (settling) state = await settleCleanup({ db, config, options, runId, context, planFile, receiptFile, inputHash: plan.input_hash, prefix: path.join(dir, `${String(n + 1).padStart(3, '0')}-cleanup-${jobId.slice(0, 8)}`), progress });
        await syncWorkload(db, run.workload_id);
        return { step, status, state };
      } catch (error) {
        // Validation and inspection only read; a failure there changes nothing on the target.
        const after: RunState = step === 'validate' ? 'ValidationFailed' : step === 'inspect' ? 'NeedsReview' : step === 'observe' ? 'NeedsRecovery' : 'NeedsReview';
        if (step === 'deploy' && !(await deployReceipt(db, config, runId))) {
          await closeNothingCreated(db, runId, run.workload_id, `${error instanceof JobFailure ? error.message : 'The deploy failed unexpectedly.'} It stopped before the runner recorded anything, so nothing was created.`);
          throw error;
        }
        await setRun(db, runId, after, error instanceof JobFailure ? error.message : 'The pilot step failed unexpectedly. Inspect the target before anything else.');
        await syncWorkload(db, run.workload_id);
        throw error;
      } finally {
        for (const f of ['plan.json', 'validation.json', 'receipt.json', 'inspection.json']) fs.rmSync(path.join(dir, f), { force: true });
      }
    },
  };
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * Re-inspects (read-only) after a clean-up until every pilot object is gone. Waiting is the only
 * outcome while objects are absent or terminating; anything else stops for review. Nothing is forced.
 */
async function settleCleanup(c: { db: DB; config: Config; options: PilotOptions; runId: string; context: string; planFile: string; receiptFile: string; inputHash: string; prefix: string; progress: (m: string) => Promise<void> }): Promise<RunState> {
  const { db, runId } = c;
  const deadline = Date.now() + c.options.cleanupWaitMs;
  for (let attempt = 1; Date.now() < deadline; attempt++) {
    await c.progress(`Deletion requested; waiting for Kubernetes to finish removing the pilot (check ${attempt})`);
    await sleep(c.options.cleanupPollMs);
    const output = `${c.prefix}-inspect-${attempt}.json`;
    await runRunner(c.config, ['inspect', '--context', c.context, '--plan', c.planFile, '--receipt', c.receiptFile, '--output', output], 5 * 60_000);
    let report: { status?: string; rows?: { state?: string }[] } & Record<string, unknown>;
    try { report = JSON.parse(fs.readFileSync(output, 'utf8')); } catch { throw new JobFailure('A follow-up inspection after clean-up wrote no readable receipt. Inspect the target before anything else.'); }
    const status = String(report.status ?? 'Unknown');
    await db.insertInto('evidence').values({ id: crypto.randomUUID(), run_id: runId, kind: `inspect:${status}`, input_hash: c.inputHash, blob_hash: await putBlob(db, report), observed_at: new Date().toISOString() }).execute();
    if (status === 'Absent') {
      await setRun(db, runId, 'Cleaned', null);
      await record(db, 'pilot.cleanup.settled', `run/${runId}`, { checks: attempt });
      return 'Cleaned';
    }
    const stillDeleting = status === 'ReviewRequired' && Array.isArray(report.rows) && report.rows.every(r => r.state === 'Absent' || r.state === 'Terminating');
    if (!stillDeleting) {
      const detail = 'After clean-up, a pilot object is no longer being deleted or no longer matches this run. Inspect it before anything else.';
      await setRun(db, runId, 'NeedsReview', detail);
      await record(db, 'pilot.cleanup.review', `run/${runId}`, { status });
      return 'NeedsReview';
    }
  }
  const minutes = Math.max(1, Math.round(c.options.cleanupWaitMs / 60_000));
  await setRun(db, runId, 'CleanupPending', `Deletion is still in progress after ${minutes} minute${minutes > 1 ? 's' : ''}. Inspect again later; nothing is forced and no finalizers are removed.`);
  return 'CleanupPending';
}

async function closeNothingCreated(db: DB, runId: string, workloadId: string, detail: string) {
  await setRun(db, runId, 'NothingCreated', detail);
  await record(db, 'pilot.deploy.nothing-created', `run/${runId}`, { detail });
  await syncWorkload(db, workloadId);
}

/**
 * At engine start, before the job runner: one engine owns the data directory, so a pilot job still
 * marked Running belongs to a process that has died. Fail it (pilot steps are never repeated) and move
 * its run to a state with a way forward; queued steps still run.
 */
export async function recoverRuns(db: DB, config: Config): Promise<number> {
  const now = new Date().toISOString();
  await db.updateTable('jobs').set({ state: 'Failed', error: 'The engine stopped while this pilot step was running. Inspect the target before anything else.', lease_owner: null, lease_until: null, updated_at: now }).where('type', '=', 'pilot').where('state', '=', 'Running').execute();
  const stuck = await db.selectFrom('runs').select(['id', 'workload_id', 'state']).where('state', 'in', ['Validating', 'Deploying', 'Observing', 'Inspecting', 'Cleaning']).execute();
  let n = 0;
  for (const r of stuck) {
    const queued = await db.selectFrom('jobs').select('id').where('type', '=', 'pilot').where('state', '=', 'Queued').where('payload', 'like', `%"runId":"${r.id}"%`).executeTakeFirst();
    if (queued) continue;
    const message = 'The engine stopped while this step was running. Inspect the target before anything else.';
    if (r.state === 'Validating') await setRun(db, r.id, 'ValidationFailed', 'The engine stopped during validation; nothing was created. Start a new run.');
    else if (r.state === 'Deploying') {
      const receipt = await deployReceipt(db, config, r.id);
      if (!receipt) { await closeNothingCreated(db, r.id, r.workload_id, 'The engine stopped before the deploy recorded anything, so nothing was created.'); n++; continue; }
      if (nextState('deploy', { ...receipt, status: 'Failed' }) === 'NothingCreated') await setRun(db, r.id, 'NothingCreated', 'The engine stopped during the deploy, before the runner created anything.');
      else await setRun(db, r.id, 'NeedsReview', message);
    } else await setRun(db, r.id, 'NeedsReview', message);
    await syncWorkload(db, r.workload_id);
    n++;
  }
  return n;
}

export async function runView(db: DB, runId: string) {
  const run = await db.selectFrom('runs').selectAll().where('id', '=', runId).executeTakeFirst();
  if (!run) return undefined;
  const plan = await db.selectFrom('plans').selectAll().where('id', '=', run.plan_id).executeTakeFirstOrThrow();
  const planDoc = await getBlob<{ workload: string; preflight: { expectedContext: string } }>(db, plan.blob_hash);
  const evidence = await db.selectFrom('evidence').selectAll().where('run_id', '=', runId).orderBy('observed_at').orderBy('id').execute();
  const steps = await Promise.all(evidence.map(async e => {
    const r = await getBlob<Record<string, unknown>>(db, e.blob_hash);
    return { id: e.id, step: e.kind.split(':')[0], status: e.kind.split(':')[1], observedAt: e.observed_at, summary: summarise(r) };
  }));
  const job = await db.selectFrom('jobs').select(['id', 'state', 'progress']).where('type', '=', 'pilot').where('payload', 'like', `%"runId":"${runId}"%`).orderBy('created_at', 'desc').limit(1).executeTakeFirst();
  return {
    id: run.id, runLabel: run.run_label, projectId: run.project_id, workloadId: run.workload_id, workload: planDoc.workload, planId: run.plan_id, revision: plan.input_hash,
    context: planDoc.preflight.expectedContext, state: run.state, detail: run.status_detail, actions: ACTIONS[run.state as RunState] ?? [], closed: CLOSED.includes(run.state as RunState),
    createdAt: run.created_at, updatedAt: run.updated_at, steps, job: job ?? null,
  };
}

/** The parts of a receipt worth showing; the full receipt stays in the store. */
function summarise(r: Record<string, unknown>) {
  const pick = (k: string) => (r[k] === undefined ? undefined : r[k]);
  return {
    status: pick('status'), error: pick('error'),
    created: pick('created'), uncertain: pick('uncertain'),
    rollout: pick('rollout'), smoke: pick('smoke'), images: pick('images'),
    rows: Array.isArray(r.rows) ? (r.rows as Record<string, unknown>[]).map(x => ({ kind: x.kind, name: x.name, namespace: x.namespace, state: x.state, detail: x.detail })) : undefined,
    dependents: Array.isArray(r.dependents) ? (r.dependents as unknown[]).length : undefined,
    actions: pick('actions'),
    preflight: Array.isArray(r.preflight) ? r.preflight : undefined,
  };
}
