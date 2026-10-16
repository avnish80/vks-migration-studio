#!/usr/bin/env node
// Test double for kubectl. Behaviour is driven by FAKE_KUBE_DIR/<context>.uid files.
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2);
// The engine passes only KUBECONFIG through, so state lives next to it.
const dir = path.dirname(process.env.KUBECONFIG);
const ctxIndex = args.indexOf('--context');
const ctx = ctxIndex >= 0 ? args[ctxIndex + 1] : undefined;
const out = v => { process.stdout.write(JSON.stringify(v)); process.exit(0); };
const fail = msg => { process.stderr.write(msg); process.exit(1); };

if (args.includes('config') && args.includes('view')) out({
  'current-context': 'lab-source',
  contexts: ['lab-source', 'lab-target', 'lab-target-pilot', 'alias-of-source', 'denied', 'down'].map(n => ({ name: n, context: { cluster: n + '-cluster', user: 'admin@corp' } })),
  clusters: ['lab-source', 'lab-target', 'lab-target-pilot', 'alias-of-source', 'denied', 'down'].map(n => ({ name: n + '-cluster', cluster: { server: 'https://' + n + '.example:6443', 'certificate-authority-data': 'DATA+OMITTED' } })),
  users: [{ name: 'admin@corp', user: { token: 'REDACTED' } }],
});
if (ctx === 'denied') fail('Error from server (Forbidden): namespaces "kube-system" is forbidden: User "secret-user@corp.example" cannot get resource');
if (ctx === 'down') fail('Unable to connect to the server: dial tcp 10.9.9.9:6443: connect: connection refused');
const uidFile = path.join(dir, (ctx === 'alias-of-source' ? 'lab-source' : ctx === 'lab-target-pilot' ? 'lab-target' : ctx) + '.uid');
const uid = fs.existsSync(uidFile) ? fs.readFileSync(uidFile, 'utf8').trim() : '00000000-0000-0000-0000-000000000000';
if (args.includes('version')) out({ serverVersion: { gitVersion: 'v1.33.4' } });
if (args.includes('api-resources')) { process.stdout.write('deployments.apps\n'); process.exit(0); }
if (args.includes('api-versions')) { process.stdout.write('v1\napps/v1\n'); process.exit(0); }
const g = args.indexOf('get');
const kind = g >= 0 ? args[g + 1] : '';
if (kind === 'namespace' && args[g + 2] === 'kube-system') out({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'kube-system', uid } });
if (kind === 'namespaces' && fs.existsSync(path.join(dir, 'hide-namespaces'))) fail('Error from server (Forbidden): namespaces is forbidden');
if (kind === 'namespaces') out({ items: [{ apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'kube-system', uid } }, { apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'app', uid: 'ns-app' } }] });
if (kind === 'deployments' && ctx === 'lab-source') out({ items: [{ apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'web', namespace: 'app', uid: 'd1' }, spec: { replicas: 2, selector: { matchLabels: { app: 'web' } }, template: { metadata: { labels: { app: 'web' } }, spec: { hostNetwork: true, containers: [{ name: 'web', image: 'nginx:1.27', env: [{ name: 'PASSWORD', value: 'ENV_SECRET_VALUE' }] }] } } } }] });
if (kind === 'services' && ctx === 'lab-source') out({ items: [{ apiVersion: 'v1', kind: 'Service', metadata: { name: 'web', namespace: 'app', uid: 's1' }, spec: { selector: { app: 'web' }, ports: [{ port: 80 }] } }] });
out({ items: [] });
