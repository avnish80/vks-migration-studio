import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Config } from './config.js';

/** Why a cluster call failed. Raw kubectl output is never returned: it can name users, servers and tokens. */
export type FailureReason = 'Forbidden' | 'Unauthorized' | 'NotFound' | 'Timeout' | 'Unreachable' | 'NoKubeconfig' | 'NoKubectl' | 'Other';

export class KubeError extends Error {
  constructor(public reason: FailureReason, message: string) { super(message); }
}

const REASONS: [FailureReason, RegExp][] = [
  ['Forbidden', /forbidden/i],
  ['Unauthorized', /unauthorized|must be logged in|credentials|token has expired|expired/i],
  ['NotFound', /not ?found|doesn.t have a resource type|context .* does not exist|no context exists/i],
  ['Timeout', /timeout|timed out|deadline/i],
  ['Unreachable', /connection refused|no such host|unable to connect|no route to host|network is unreachable/i],
];

const MESSAGES: Record<FailureReason, string> = {
  Forbidden: 'The cluster refused this request. The kubeconfig user lacks permission (RBAC).',
  Unauthorized: 'The cluster did not accept the credentials. For VKS, run kubectl vsphere login again, or use a collector kubeconfig.',
  NotFound: 'The context or resource was not found in the kubeconfig or cluster.',
  Timeout: 'The cluster did not answer in time.',
  Unreachable: 'The cluster API server could not be reached from where the engine runs.',
  NoKubeconfig: 'No kubeconfig is available to the engine. Mount one, or set KUBECONFIG.',
  NoKubectl: 'kubectl is not installed where the engine runs.',
  Other: 'The cluster request failed. Check the context with kubectl where the engine runs.',
};

export function classify(stderr: string): FailureReason {
  for (const [reason, pattern] of REASONS) if (pattern.test(stderr)) return reason;
  return 'Other';
}

export function failure(reason: FailureReason): KubeError { return new KubeError(reason, MESSAGES[reason]); }

/** Context names are passed as a single argv element; still refuse anything unusual. */
export function validContextName(name: unknown): name is string {
  return typeof name === 'string' && name.length > 0 && name.length <= 253 && !/[\s\x00-\x1f]/.test(name) && !name.startsWith('-');
}

/**
 * Environment for kubectl and the collector: the kubeconfig is passed explicitly and HOME points at
 * a private temporary folder, so kubectl's discovery cache works on a read-only filesystem.
 */
export function kubeEnv(config: Config): NodeJS.ProcessEnv {
  const cache = path.join(os.tmpdir(), 'studio-kube-cache');
  fs.mkdirSync(cache, { recursive: true, mode: 0o700 });
  // The operator's environment is kept (exec credential plugins for EKS, GKE and AKS need HOME and
  // their cloud variables). Only the kubeconfig and the discovery cache location are set explicitly.
  const { STUDIO_TOKEN: _token, ...env } = process.env;   // never hand the engine's own token to child processes
  return { ...env, KUBECONFIG: config.kubeconfig, KUBECACHEDIR: cache };
}

/** True if any file in a (possibly colon-separated) KUBECONFIG exists. */
export function kubeconfigPresent(value: string): boolean {
  return value.split(path.delimiter).some(f => f && fs.existsSync(f));
}

export function kubectl(config: Config, args: string[], timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(config.kubectl, ['--request-timeout=20s', ...args], { env: kubeEnv(config), timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (!error) return resolve(stdout);
      const e = error as NodeJS.ErrnoException & { killed?: boolean };
      if (e.code === 'ENOENT') return reject(failure('NoKubectl'));
      if (e.killed) return reject(failure('Timeout'));
      if (!kubeconfigPresent(config.kubeconfig) && /config|context/i.test(stderr)) return reject(failure('NoKubeconfig'));
      reject(failure(classify(String(stderr))));
    });
  });
}

export interface KubeContext { name: string; cluster: string; server: string; namespace: string; current: boolean }

/** Contexts from the kubeconfig. kubectl redacts credentials unless --raw is given, and we never pass it. */
export async function listContexts(config: Config): Promise<KubeContext[]> {
  if (!kubeconfigPresent(config.kubeconfig)) throw failure('NoKubeconfig');
  const view = JSON.parse(await kubectl(config, ['config', 'view', '-o', 'json'])) as {
    'current-context'?: string;
    contexts?: { name: string; context?: { cluster?: string; namespace?: string } }[];
    clusters?: { name: string; cluster?: { server?: string } }[];
  };
  const servers = new Map((view.clusters ?? []).map(c => [c.name, c.cluster?.server ?? '']));
  return (view.contexts ?? []).filter(c => validContextName(c.name)).map(c => ({
    name: c.name,
    cluster: c.context?.cluster ?? '',
    server: servers.get(c.context?.cluster ?? '') ?? '',
    namespace: c.context?.namespace ?? '',
    current: c.name === view['current-context'],
  }));
}

/** The kube-system namespace UID identifies a cluster, independent of context names and addresses. */
export async function clusterUid(config: Config, context: string): Promise<string> {
  if (!validContextName(context)) throw new KubeError('NotFound', 'Invalid context name.');
  const ns = JSON.parse(await kubectl(config, ['--context', context, 'get', 'namespace', 'kube-system', '-o', 'json'])) as { metadata?: { uid?: string } };
  const uid = ns.metadata?.uid;
  if (typeof uid !== 'string' || !/^[0-9a-f-]{8,64}$/i.test(uid)) throw failure('Other');
  return uid;
}

/** `kubectl auth can-i`: true for "yes". It exits 1 for "no", so the exit code alone is not an error. */
export function canI(config: Config, context: string, args: string[]): Promise<boolean> {
  if (!validContextName(context)) return Promise.reject(new KubeError('NotFound', 'Invalid context name.'));
  return new Promise((resolve, reject) => {
    execFile(config.kubectl, ['--request-timeout=20s', '--context', context, 'auth', 'can-i', ...args], { env: kubeEnv(config), timeout: 30_000 }, (error, stdout, stderr) => {
      const answer = String(stdout).trim().split('\n')[0];
      if (answer === 'yes') return resolve(true);
      if (answer === 'no') return resolve(false);
      const e = error as (NodeJS.ErrnoException & { killed?: boolean }) | null;
      if (e?.code === 'ENOENT') return reject(failure('NoKubectl'));
      if (e?.killed) return reject(failure('Timeout'));
      reject(failure(classify(String(stderr))));
    });
  });
}
