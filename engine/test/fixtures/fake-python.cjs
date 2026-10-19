#!/usr/bin/env node
// Test double for "python3 pilot-runner.py MODE ...": writes the receipt the real runner would,
// following <dirname KUBECONFIG>/scenario.json, and logs its arguments to calls.log.
const fs = require('node:fs'), path = require('node:path');
const dir = path.dirname(process.env.KUBECONFIG);
const args = process.argv.slice(2).filter(a => a !== '-I' && a !== '-B');
fs.appendFileSync(path.join(dir, 'calls.log'), JSON.stringify(args) + '\n');
const [script, mode, ...rest] = args;
if (!script.endsWith('pilot-runner.py')) { process.stderr.write('fake python only runs pilot-runner.py'); process.exit(2); }
const opt = k => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : undefined; };
const scenario = fs.existsSync(path.join(dir, 'scenario.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'scenario.json'), 'utf8')) : {};
const plan = JSON.parse(fs.readFileSync(opt('--plan'), 'utf8'));
const receipt = opt('--receipt') ? JSON.parse(fs.readFileSync(opt('--receipt'), 'utf8')) : null;
const base = { schemaVersion: 1, binding: plan.binding, planRevision: plan.planRevision, workload: plan.workload, context: opt('--context'), clusterUID: plan.preflight.expectedClusterUID, observedAt: new Date().toISOString() };
const objects = plan.preflight.manifests.items.map(r => ({ kind: r.kind, name: r.metadata.name, namespace: r.metadata.namespace, uid: r.kind + '-uid' }));
// "Crash": the runner dies before its first save (deploy) or right after creating the empty output file.
if (scenario[mode] === 'Crash') { if (mode !== 'deploy') fs.writeFileSync(opt('--output'), ''); process.exit(1); }
let report;
// A list plays one entry per call, then repeats the last ("Terminating" is an inspection that finds objects still deleting).
const pick = v => { if (!Array.isArray(v)) return v; const f = path.join(dir, mode + '.count'); const i = fs.existsSync(f) ? Number(fs.readFileSync(f, 'utf8')) : 0; fs.writeFileSync(f, String(i + 1)); return v[Math.min(i, v.length - 1)]; };
const picked = pick(scenario[mode]);
const terminating = picked === 'Terminating';
const want = terminating ? 'ReviewRequired' : picked ?? ({ inspect: 'ReviewRequired', cleanup: 'Absent' }[mode] ?? 'Passed');
if (mode === 'validate' || mode === 'deploy') {
  const runId = receipt?.runId ?? require('node:crypto').randomUUID();
  report = { ...base, kind: 'PilotExecutionResult', runId, mode, status: want === 'Passed' ? 'Passed' : 'Failed', preflightPassed: true, created: [], uncertain: [] };
  if (mode === 'deploy' && want === 'Passed') report.created = objects;
  if (mode === 'deploy' && want === 'FailedCreated') { report.created = objects.slice(0, 1); report.error = 'Rollout failed or timed out'; }
  if (mode === 'deploy' && want === 'Hang') { fs.writeFileSync(opt('--output'), JSON.stringify({ ...report, status: 'Started', created: objects.slice(0, 1) })); setTimeout(() => {}, 1e9); return; }
} else if (mode === 'observe') {
  report = { ...base, kind: 'PilotObservationResult', runId: receipt.runId, status: want };
} else if (mode === 'inspect') {
  report = { ...base, kind: 'PilotInspectionResult', runId: receipt.runId, inspectionId: 'insp-' + Date.now(), status: want, rows: objects.map(o => ({ ...o, state: want === 'Absent' ? 'Absent' : terminating ? 'Terminating' : 'Owned' })), dependents: [] };
} else if (mode === 'cleanup') {
  // Like the real runner: the confirmation must be the run ID on the target objects.
  const ok = opt('--confirm-run') === receipt.runId && rest.includes('--ack-external-state');
  report = { ...base, kind: 'PilotCleanupResult', runId: receipt.runId, status: ok ? want : 'Failed', rows: [], actions: [], ...(ok ? {} : { error: 'Cleanup needs exact --confirm-run' }) };
}
fs.writeFileSync(opt('--output'), JSON.stringify(report));
process.exit(report.status === 'Passed' || report.status === 'Absent' || report.status === 'ReviewRequired' ? 0 : 1);
