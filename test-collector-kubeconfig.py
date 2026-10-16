"""scripts/collector-kubeconfig.sh: read-only RBAC, private output file, no overwrite."""
import os, stat, subprocess, tempfile, unittest
import yaml
from pathlib import Path

FAKE = r'''#!/usr/bin/env bash
log="$FAKE_DIR/calls"; echo "$*" >> "$log"
case "$*" in
  *" apply -f "*) cp "${@: -1}" "$FAKE_DIR/applied.yaml"; exit 0;;
  *"jsonpath={.data.token}"*) printf '%s' "$(printf 'collector-token' | base64)"; exit 0;;
  *"jsonpath={.data.ca\.crt}"*) printf 'Q0EtREFUQQ=='; exit 0;;
  *"config view --minify"*) printf 'https://vks-lab.example:6443'; exit 0;;
esac
exit 1
'''

class CollectorKubeconfig(unittest.TestCase):
    def run_script(self, out):
        d = tempfile.mkdtemp(); fake = Path(d, 'kubectl'); fake.write_text(FAKE); fake.chmod(0o755)
        env = {**os.environ, 'PATH': d + os.pathsep + os.environ['PATH'], 'FAKE_DIR': d}
        r = subprocess.run(['bash', 'scripts/collector-kubeconfig.sh', 'lab', str(out)], env=env, capture_output=True, text=True)
        return r, d

    def test_writes_private_kubeconfig_with_read_only_rbac(self):
        out = Path(tempfile.mkdtemp(), 'lab.kubeconfig')
        r, d = self.run_script(out)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(stat.S_IMODE(out.stat().st_mode), 0o600)
        text = out.read_text()
        self.assertIn('token: collector-token', text)
        self.assertIn('server: https://vks-lab.example:6443', text)
        docs = list(yaml.safe_load_all(Path(d, 'applied.yaml').read_text()))
        role = next(x for x in docs if x['kind'] == 'ClusterRole')
        for rule in role['rules']:
            self.assertEqual(rule['verbs'], ['get', 'list'])
            self.assertFalse({'secrets', 'configmaps'} & set(rule['resources']), rule)
            if '*' in rule['resources']:
                self.assertEqual(rule['apiGroups'], ['constraints.gatekeeper.sh'], 'wildcard resources only for Gatekeeper constraint kinds')
            self.assertNotIn('pods', rule['resources'])
        # Every resource dist/collect.py reads is granted.
        granted = {(g, r) for rule in role['rules'] for g in rule['apiGroups'] for r in rule['resources']}
        src = Path('dist/collect.py').read_text()
        import re
        core = re.search(r"resources=\[(.*?)\]", src).group(1)
        optional = re.search(r"optional=\[(.*?)\]", src).group(1)
        names = [n.strip("' ") for n in core.split(',')] + [n.strip("' ") for n in optional.split(',')]
        groups = {'deployments': 'apps', 'statefulsets': 'apps', 'daemonsets': 'apps', 'jobs': 'batch', 'cronjobs': 'batch', 'ingresses': 'networking.k8s.io', 'ingressclasses': 'networking.k8s.io', 'networkpolicies': 'networking.k8s.io', 'storageclasses': 'storage.k8s.io', 'roles': 'rbac.authorization.k8s.io', 'rolebindings': 'rbac.authorization.k8s.io', 'clusterroles': 'rbac.authorization.k8s.io', 'clusterrolebindings': 'rbac.authorization.k8s.io', 'poddisruptionbudgets': 'policy', 'horizontalpodautoscalers': 'autoscaling', 'customresourcedefinitions': 'apiextensions.k8s.io', 'validatingwebhookconfigurations': 'admissionregistration.k8s.io', 'mutatingwebhookconfigurations': 'admissionregistration.k8s.io', 'validatingadmissionpolicies': 'admissionregistration.k8s.io', 'validatingadmissionpolicybindings': 'admissionregistration.k8s.io'}
        for n in names:
            res, _, grp = n.partition('.')
            grp = grp or groups.get(res, '')
            self.assertIn((grp, res), granted, f'collector reads {n} but the role does not grant it')
        self.assertNotIn('collector-token', r.stdout)

    def test_refuses_unusual_context_names(self):
        d = tempfile.mkdtemp(); fake = Path(d, 'kubectl'); fake.write_text(FAKE); fake.chmod(0o755)
        env = {**os.environ, 'PATH': d + os.pathsep + os.environ['PATH'], 'FAKE_DIR': d}
        r = subprocess.run(['bash', 'scripts/collector-kubeconfig.sh', 'bad: name', str(Path(d, 'o'))], env=env, capture_output=True, text=True)
        self.assertNotEqual(r.returncode, 0)
        self.assertFalse(Path(d, 'applied.yaml').exists())

    def test_refuses_to_overwrite(self):
        out = Path(tempfile.mkdtemp(), 'exists'); out.write_text('keep')
        r, _ = self.run_script(out)
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual(out.read_text(), 'keep')

if __name__ == '__main__':
    unittest.main()
