import copy,importlib.util,json,subprocess,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('recovery_tests','test-pilot-recovery.py');base=importlib.util.module_from_spec(spec);spec.loader.exec_module(base)
r=base.r
class Observation(unittest.TestCase):
 # Reuse the UID-bound cluster fixture and command assertions.
 setUp=base.Recovery.setUp
 save=base.Recovery.save
 def command(self,context,args,body=None,timeout=60):
  if args[:2]==['rollout','status']:
   self.assertEqual(context,'target');self.calls.append((args,body));return 'complete'
  if args[:2]==['get','replicasets.apps']:
   self.calls.append((args,body));return json.dumps({'items':[{'metadata':{'uid':'rs-uid','ownerReferences':[{'uid':'Deployment-uid','controller':True}]}}]})
  if args[:2]==['get','pods']:
   self.calls.append((args,body));image=self.p['preflight']['manifests']['items'][0]['spec']['template']['spec']['containers'][0]['image'] if self.p['preflight']['manifests']['items'][0]['kind']=='Deployment' else next(x for x in self.p['preflight']['manifests']['items'] if x['kind']=='Deployment')['spec']['template']['spec']['containers'][0]['image']
   return json.dumps({'items':[{'metadata':{'name':'web-pod','labels':{r.LABEL:'run-1'},'ownerReferences':[{'uid':'rs-uid','controller':True}]},'spec':{'containers':[{'name':'web','image':image}]},'status':{'conditions':[{'type':'Ready','status':'True'}],'containerStatuses':[{'name':'web','image':image,'imageID':'containerd://sha256:'+'b'*64,'ready':True}]}}]})
  return base.Recovery.command(self,context,args,body,timeout)
 def observe(self,command=None,smoke=None):
  with patch.object(r,'command',side_effect=command or self.command),patch.object(r,'smoke',side_effect=smoke or (lambda *a:{'status':'Pass','detail':'Approved probe matched'})) as probe:
   out=r.observe_run(self.p,'target',self.receipt,self.save)
  self.assertFalse(any(a[0] in ['create','apply','patch','delete','replace'] for a,b in self.calls));self.probes=probe.call_count;return out
 def test_observe_success_and_browser_import(self):
  out=self.observe();self.assertEqual(out['status'],'Passed');self.assertTrue(out['identityMatched']);self.assertEqual(self.probes,1);self.assertEqual(out['runId'],'run-1');self.assertFalse(out['productionReady'])
  script="const X=require('./dist/execution'),v=JSON.parse(require('fs').readFileSync(0,'utf8')),p=JSON.parse(require('child_process').execFileSync('node',['test-execution.cjs','--fixture']));const o=X.observationEvidence(p,X.evidence(p,v.receipt),v.observation);if(o.status!=='Passed'||o.productionReady)process.exit(1)";out=subprocess.run(['node','-e',script],input=json.dumps({'receipt':self.receipt,'observation':out}),text=True,capture_output=True);self.assertEqual(out.returncode,0,out.stderr)
 def test_partial_receipt_does_not_probe(self):
  self.receipt['created'].pop();out=self.observe();self.assertEqual(out['status'],'Failed');self.assertEqual(self.calls,[]);self.assertEqual(self.probes,0)
 def test_changed_missing_or_terminating_root_does_not_probe(self):
  original=copy.deepcopy(self.objects)
  for change in ['uid','missing','terminating']:
   self.objects=copy.deepcopy(original)
   if change=='uid':self.objects[('Deployment','web')]['metadata']['uid']='replacement'
   elif change=='missing':del self.objects[('Service','web')]
   else:self.objects[('Service','web')]['metadata']['deletionTimestamp']=r.now()
   self.assertEqual(self.observe()['status'],'Failed');self.assertEqual(self.probes,0)
 def test_wrong_cluster_does_not_probe(self):
  def wrong(ctx,args,body=None,timeout=60):return '{"metadata":{"uid":"other"}}' if args[:3]==['get','namespaces','kube-system'] else self.command(ctx,args,body,timeout)
  self.assertEqual(self.observe(command=wrong)['status'],'Failed');self.assertEqual(self.probes,0)
 def test_rollout_failure_captures_images_and_omits_raw_diagnostics(self):
  def fail(ctx,args,body=None,timeout=60):
   if args[0]=='rollout':raise RuntimeError('RAW_SECRET')
   return self.command(ctx,args,body,timeout)
  out=self.observe(command=fail);self.assertEqual(out['status'],'Failed');self.assertEqual(len(out['images']),1);self.assertEqual(self.probes,0);self.assertNotIn('RAW_SECRET',json.dumps(out))
 def test_failed_smoke_and_post_probe_identity_change(self):
  out=self.observe(smoke=lambda *a:{'status':'Fail','detail':'Unexpected HTTP status'});self.assertEqual(out['status'],'Failed')
  def changed(*a):self.objects[('Service','web')]['metadata']['uid']='replacement';return {'status':'Pass','detail':'Matched'}
  out=self.observe(smoke=changed);self.assertEqual(out['status'],'Failed');self.assertFalse(out['identityMatched'])
 def test_observe_cli_private_exclusive_output(self):
  with tempfile.TemporaryDirectory() as directory:
   base=Path(directory);(base/'plan.json').write_text(json.dumps(self.p));(base/'receipt.json').write_text(json.dumps(self.receipt));out=base/'observe.json';args=['runner','observe','--context','target','--plan',str(base/'plan.json'),'--receipt',str(base/'receipt.json'),'--output',str(out)]
   with patch.object(r.sys,'argv',args),patch.object(r,'command',side_effect=self.command),patch.object(r,'smoke',return_value={'status':'Pass','detail':'Matched'}):
    self.assertEqual(r.main(),0);self.assertEqual(json.loads(out.read_text())['kind'],'PilotObservationResult');self.assertEqual(out.stat().st_mode&0o777,0o600);self.assertRaises(FileExistsError,r.main)
if __name__=='__main__':unittest.main()
