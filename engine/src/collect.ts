import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Config } from './config.js';
import type { Core } from './core.js';
import type { DB } from './db/index.js';
import { JobFailure, type JobHandler } from './jobs.js';
import { clusterUid, KubeError, kubeEnv } from './kube.js';
import { inventoryClusterUid, InventoryError, storeSnapshot } from './inventory.js';

export interface CollectPayload { projectId: string; side: 'source' | 'target'; clusterId: string }

/** Runs the existing read-only collector (dist/collect.py) against a registered cluster. */
export function collectHandler(db: DB, core: Core, config: Config): JobHandler {
  return {
    retryable: true,
    maxAttempts: 2,
    async run({ payload, progress }) {
      const { projectId, side, clusterId } = payload as CollectPayload;
      const cluster = await db.selectFrom('clusters').selectAll().where('id', '=', clusterId).executeTakeFirst();
      if (!cluster) throw new JobFailure('The cluster is no longer registered.');

      await progress('Checking cluster identity');
      let uid: string;
      try { uid = await clusterUid(config, cluster.context_name); }
      catch (e) { const message = e instanceof KubeError ? e.message : 'Could not reach the cluster.'; await setError(db, clusterId, message); throw new JobFailure(message); }
      if (cluster.observed_uid && uid !== cluster.observed_uid) {
        const message = `Context ${cluster.context_name} now points to a different cluster than when it was registered. Check the kubeconfig, then register it again.`;
        await setError(db, clusterId, message);
        throw new JobFailure(message);
      }

      await progress('Collecting inventory (read-only; large clusters take a few minutes)');
      const raw = await runCollector(config, cluster.context_name);
      // Bind the snapshot to the cluster we checked, not to whatever the context points at now.
      const collectedUid = inventoryClusterUid(raw as never);
      if (collectedUid && collectedUid !== uid) throw new JobFailure('The cluster changed during collection. Run the collection again.');

      await progress('Analysing inventory');
      try {
        const stored = await storeSnapshot(db, core, { projectId, side, origin: 'collected', clusterId, raw });
        await db.updateTable('clusters').set({ last_seen_at: new Date().toISOString(), last_error: null }).where('id', '=', clusterId).execute();
        return stored;
      } catch (e) {
        if (e instanceof InventoryError) throw new JobFailure(collectionProblem(raw) ?? e.message);
        throw e;
      }
    },
  };
}

async function setError(db: DB, clusterId: string, message: string) {
  await db.updateTable('clusters').set({ last_error: message }).where('id', '=', clusterId).execute();
}

/** Explains an empty collection from the collector's own error categories. */
function collectionProblem(raw: unknown): string | undefined {
  const errors = (raw as { collection?: { errors?: { reason?: string }[] } })?.collection?.errors ?? [];
  if (!errors.length) return undefined;
  const reasons = [...new Set(errors.map(e => e.reason).filter(Boolean))].slice(0, 3).join(', ');
  return `The collector could not read any resources (${reasons}). Check that the kubeconfig user can list resources in this cluster.`;
}

export function runCollector(config: Config, context: string, timeoutMs = 15 * 60_000): Promise<unknown> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-collect-'));
  const output = path.join(dir, 'inventory.json');
  const script = path.join(config.coreDir, 'collect.py');
  return new Promise((resolve, reject) => {
    execFile(config.python, ['-I', '-B', script, '--context', context, '--output', output], { env: kubeEnv(config), timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, error => {
      try {
        if (error) {
          const e = error as NodeJS.ErrnoException & { killed?: boolean };
          if (e.code === 'ENOENT') return reject(new JobFailure('Python 3 is not installed where the engine runs.'));
          if (e.killed) return reject(new JobFailure('Collection took longer than 15 minutes and was stopped.'));
          return reject(new JobFailure('The collector stopped with an error. Check that kubectl works with this context where the engine runs.'));
        }
        resolve(JSON.parse(fs.readFileSync(output, 'utf8')));
      } catch {
        reject(new JobFailure('The collector produced no readable inventory.'));
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
}
