import hashlib, importlib.util, json, subprocess, unittest
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('runner','dist/image-runner.py');r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)
RAW=json.dumps({'schemaVersion':2,'manifests':[{'platform':{'os':'linux','architecture':'amd64'}}]},separators=(',',':')).encode();DIGEST='sha256:'+hashlib.sha256(RAW).hexdigest()
class RunnerTests(unittest.TestCase):
    def plan(self):return {'schemaVersion':1,'errors':[],'rows':[{'source':'nginx:x','sourceCanonical':'docker.io/library/nginx:x','destination':'harbor.example.com/p/web:x','operation':'Copy'}]}
    def test_default_no_copy(self):
        with patch.object(r,'command',return_value=RAW) as call:
            report=r.run(self.plan());self.assertEqual(report['results'][0]['status'],'Registry digest match');self.assertFalse(any(c.args[0][0]=='copy' for c in call.call_args_list))
    def test_copy_pins_source_and_all_platforms(self):
        with patch.object(r,'command',return_value=RAW) as call:
            report=r.run(self.plan(),True);args=next(c.args[0] for c in call.call_args_list if c.args[0][0]=='copy');self.assertIn('--all',args);self.assertIn('--preserve-digests',args);self.assertIn('docker://docker.io/library/nginx@'+DIGEST,args);self.assertTrue(report['results'][0]['copied'])
    def test_digest_mismatch(self):
        with patch.object(r,'command',side_effect=[RAW,b'{"schemaVersion":2}']):self.assertEqual(r.run(self.plan())['results'][0]['status'],'Failed')
    def test_pinned_source_mismatch_stops_before_copy(self):
        p=self.plan();p['rows'][0]['sourceCanonical']='docker.io/library/nginx@sha256:'+'f'*64
        with patch.object(r,'command',return_value=RAW) as call:self.assertEqual(r.run(p,True)['results'][0]['status'],'Failed');self.assertEqual(call.call_count,1)
    def test_invalid_plan_and_no_shell(self):
        with self.assertRaises(ValueError):r.run({'schemaVersion':1,'rows':[],'errors':['bad']},True)
        with patch.object(r.subprocess,'run',return_value=subprocess.CompletedProcess([],0,RAW,b'')) as call:r.command(['inspect','--raw','docker://example.com/a:x']);self.assertEqual(call.call_args.args[0][0],'skopeo');self.assertNotIn('shell',call.call_args.kwargs)
    def test_auth_diagnostics_are_not_exported(self):
        with patch.object(r.subprocess,'run',return_value=subprocess.CompletedProcess([],1,b'',b'SECRET_DIAGNOSTIC')):self.assertNotIn('SECRET_DIAGNOSTIC',json.dumps(r.run(self.plan())))
    def test_legacy_manifest_rejected(self):
        with patch.object(r,'command',return_value=b'{"schemaVersion":1}'):self.assertEqual(r.run(self.plan())['results'][0]['status'],'Failed')
    def test_reuse_and_errors_continue(self):
        p=self.plan();p['rows'].append({**p['rows'][0],'source':'other','sourceCanonical':'docker.io/other:x'})
        with patch.object(r,'command',side_effect=[RuntimeError('failed'),RAW,RAW]):report=r.run(p);self.assertEqual([x['status'] for x in report['results']],['Failed','Registry digest match'])
unittest.main()
