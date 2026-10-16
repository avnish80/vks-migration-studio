"""scripts/pilot-kubeconfig.sh: write access confined to one namespace, private output."""
import os, stat, subprocess, tempfile, unittest
import yaml
from pathlib import Path

FAKE = r'''#!/usr/bin/env bash
echo "$*" >> "$FAKE_DIR/calls"
case "$*" in
  *" get namespace missing"*) exit 1;;
  *" get namespace "*) exit 0;;
  *" apply -f -"*) cat > "$FAKE_DIR/applied.yaml"; exit 0;;
  *"jsonpath={.data.token}"*) printf '%s' "$(printf 'pilot-token' | base64)"; exit 0;;
  *"jsonpath={.data.ca\.crt}"*) printf 'Q0E='; exit 0;;
  *"config view --minify"*) printf 'https://vks.example:6443'; exit 0;;
esac
exit 1
'''

class PilotKubeconfig(unittest.TestCase):
    def run_script(self, *args):
        d = tempfile.mkdtemp(); fake = Path(d, 'kubectl'); fake.write_text(FAKE); fake.chmod(0o755)
        env = {**os.environ, 'PATH': d + os.pathsep + os.environ['PATH'], 'FAKE_DIR': d}
        return subprocess.run(['bash', 'scripts/pilot-kubeconfig.sh', *args], env=env, capture_output=True, text=True), d

    def test_write_access_only_in_the_pilot_namespace(self):
        out = Path(tempfile.mkdtemp(), 'p.kubeconfig')
        r, d = self.run_script('vks', 'payments', str(out))
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(stat.S_IMODE(out.stat().st_mode), 0o600)
        config = yaml.safe_load(out.read_text())
        self.assertEqual(config['contexts'][0]['name'], 'vks-pilot-payments')
        self.assertEqual(config['contexts'][0]['context']['namespace'], 'payments')
        docs = list(yaml.safe_load_all(Path(d, 'applied.yaml').read_text()))
        self.assertNotIn('__NAMESPACE__', Path(d, 'applied.yaml').read_text())
        self.assertNotIn('__NAME__', Path(d, 'applied.yaml').read_text())
        # One service account per namespace, so a second namespace never widens an existing login.
        sa = next(x for x in docs if x['kind'] == 'ServiceAccount')
        self.assertEqual(sa['metadata']['name'], 'vks-migration-studio-pilot-payments')
        self.assertEqual(config['users'][0]['user']['token'], 'pilot-token')
        cluster_role = next(x for x in docs if x['kind'] == 'ClusterRole')
        for rule in cluster_role['rules']:
            self.assertTrue(set(rule['verbs']) <= {'get', 'list'}, rule)
        role = next(x for x in docs if x['kind'] == 'Role')
        self.assertEqual(role['metadata']['namespace'], 'payments')
        writes = {r for rule in role['rules'] for r in rule['resources'] if set(rule['verbs']) & {'create', 'patch', 'delete', 'update'}}
        self.assertEqual(writes, {'deployments', 'services', 'pods/portforward'})
        for rule in role['rules'] + cluster_role['rules']:
            self.assertNotIn('*', rule['resources']); self.assertNotIn('*', rule['verbs'])
        binding = next(x for x in docs if x['kind'] == 'RoleBinding')
        self.assertEqual(binding['metadata']['namespace'], 'payments')
        self.assertEqual(binding['subjects'][0]['name'], 'vks-migration-studio-pilot-payments')
        cluster_binding = next(x for x in docs if x['kind'] == 'ClusterRoleBinding')
        self.assertEqual(cluster_binding['metadata']['name'], 'vks-migration-studio-pilot-payments')

    def test_default_output_name_and_empty_server(self):
        r, d = self.run_script('vks', 'payments')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertTrue(Path('vks-pilot-payments.kubeconfig').exists()); Path('vks-pilot-payments.kubeconfig').unlink()
        fake = Path(d, 'kubectl'); fake.write_text(FAKE.replace("printf 'https://vks.example:6443'", "printf ''"))
        out = Path(tempfile.mkdtemp(), 'p.kubeconfig')
        r = subprocess.run(['bash', 'scripts/pilot-kubeconfig.sh', 'vks', 'payments', str(out)], env={**os.environ, 'PATH': d + os.pathsep + os.environ['PATH'], 'FAKE_DIR': d}, capture_output=True, text=True)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('API server address', r.stderr)
        self.assertFalse(out.exists())

    def test_refuses_missing_namespace_and_bad_names(self):
        for args in [('vks', 'missing'), ('vks', 'Bad_NS'), ('bad: ctx', 'payments')]:
            r, d = self.run_script(*args, str(Path(tempfile.mkdtemp(), 'o')))
            self.assertNotEqual(r.returncode, 0, args)
            self.assertFalse(Path(d, 'applied.yaml').exists(), args)

if __name__ == '__main__':
    unittest.main()
