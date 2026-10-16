import copy,datetime,importlib.util,json,subprocess,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('pilot','dist/pilot-runner.py');r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)
P=json.loads(subprocess.check_output(['node','test-execution.cjs','--fixture'],text=True))
class Recovery(unittest.TestCase):
 def setUp(self):
  self.p=copy.deepcopy(P);self.objects={};self.children=[];self.calls=[];self.saves=[]
  self.receipt={k:self.p[k] for k in ['binding','planRevision','workload']};self.receipt.update(schemaVersion=1,kind='PilotExecutionResult',context='target',clusterUID='target-cluster',runId='run-1',mode='deploy',status='Failed',observedAt=r.now(),preflightPassed=True,created=[],uncertain=[],rollout={'status':'Error'},smoke={'status':'NotRun'},images=[],error='Stopped after create')
  for obj in self.p['preflight']['manifests']['items']:
   obj=copy.deepcopy(obj);m=obj['metadata'];m.update(uid=obj['kind']+'-uid',resourceVersion='10');m.setdefault('labels',{})[r.LABEL]='run-1';
   if obj['kind']=='Deployment':obj['spec']['selector'].setdefault('matchLabels',{})[r.LABEL]='run-1';obj['spec']['template']['metadata'].setdefault('labels',{})[r.LABEL]='run-1'
   else:obj['spec']['selector'][r.LABEL]='run-1'
   self.objects[(obj['kind'],m['name'])]=obj;self.receipt['created'].append({'kind':obj['kind'],'name':m['name'],'namespace':m['namespace'],'uid':m['uid']})
 def save(self,obj):self.saves.append(copy.deepcopy(obj))
 def command(self,context,args,body=None,timeout=60):
  self.assertEqual(context,'target');self.calls.append((args,body))
  if args[:3]==['get','namespaces','kube-system']:return '{"metadata":{"uid":"target-cluster"}}'
  if args[:2]==['get','replicasets.apps,pods']:return json.dumps({'items':self.children})
  if args[0]=='get':
   kind={'deployments.apps':'Deployment','services':'Service'}[args[1]];return json.dumps(self.objects[(kind,args[2])]) if (kind,args[2]) in self.objects else ''
  if args[0]=='delete':
   self.assertEqual(args[-2:],['-f','-']);path=args[1].split('=',1)[1];kind='Deployment' if '/deployments/' in path else 'Service';key=(kind,path.rsplit('/',1)[1]);obj=self.objects[key];options=json.loads(body);self.assertEqual(set(options),{'apiVersion','kind','preconditions','propagationPolicy'});self.assertEqual(options['kind'],'DeleteOptions');self.assertEqual(options['propagationPolicy'],'Foreground');self.assertEqual(set(options['preconditions']),{'uid','resourceVersion'})
   if obj['metadata']['uid']!=options['preconditions']['uid'] or obj['metadata']['resourceVersion']!=options['preconditions']['resourceVersion']:raise RuntimeError('409 precondition conflict RAW_SECRET')
   self.assertEqual(self.saves[-1]['actions'][-1]['outcome'],'Requesting','Journal must precede delete');del self.objects[key];return '{"status":"Success"}'
  raise AssertionError(args)
 def inspect(self):
  with patch.object(r,'command',side_effect=self.command):return r.recovery_run(self.p,'target',self.receipt,'inspect',self.save)
 def cleanup(self,inspection,command=None,confirm='run-1',ack=True):
  with patch.object(r,'command',side_effect=command or self.command):return r.recovery_run(self.p,'target',self.receipt,'cleanup',self.save,inspection,confirm,ack)
 def deletes(self):return [x for x in self.calls if x[0][0]=='delete']
 def test_inspection_is_read_only_and_complete(self):
  out=self.inspect();self.assertEqual(out['status'],'ReviewRequired');self.assertEqual(len(out['rows']),2);self.assertTrue(all(x['state']=='Owned' for x in out['rows']));self.assertEqual(self.deletes(),[]);self.assertFalse(out['productionReady'])
 def test_guarded_cleanup_services_first_and_scoped_absence(self):
  inspection=self.inspect();out=self.cleanup(inspection);self.assertEqual(out['status'],'Absent');self.assertEqual(len(self.deletes()),2);self.assertIn('/services/',self.deletes()[0][0][1]);self.assertIn('/deployments/',self.deletes()[1][0][1]);self.assertTrue(all(x['outcome']=='Requested' for x in out['actions']));self.assertFalse(out['productionReady']);self.assertEqual(self.inspect()['status'],'Absent')
 def test_missing_ack_wrong_run_or_stale_inspection_no_deletes(self):
  inspection=self.inspect()
  for confirm,ack in [('other',True),('run-1',False)]:self.assertEqual(self.cleanup(inspection,confirm=confirm,ack=ack)['status'],'Failed')
  inspection['observedAt']='2000-01-01T00:00:00Z';self.assertEqual(self.cleanup(inspection)['status'],'Failed');self.assertEqual(self.deletes(),[])
 def test_recreated_object_or_changed_resource_version_blocks_before_deletes(self):
  inspection=self.inspect();self.objects[('Deployment','web')]['metadata']['uid']='other-uid';self.assertEqual(self.cleanup(inspection)['status'],'Failed');self.assertEqual(self.deletes(),[])
  self.objects[('Deployment','web')]['metadata']['uid']='Deployment-uid';self.objects[('Deployment','web')]['metadata']['resourceVersion']='11';self.assertEqual(self.cleanup(inspection)['status'],'Failed');self.assertEqual(self.deletes(),[])
 def test_race_after_final_read_is_blocked_by_api_preconditions(self):
  inspection=self.inspect();reads=0
  def race(ctx,args,body=None,timeout=60):
   nonlocal reads
   text=self.command(ctx,args,body,timeout)
   if args[:2]==['get','services']:
    reads+=1
    if reads==2:self.objects[('Service','web')]['metadata']['resourceVersion']='11'
   return text
  out=self.cleanup(inspection,command=race);self.assertEqual(out['status'],'Failed');self.assertEqual(out['actions'][0]['outcome'],'Error');self.assertEqual(len(self.deletes()),1);self.assertEqual(len(self.objects),2);self.assertNotIn('RAW_SECRET',json.dumps(out))
 def test_changed_cluster_stops_before_mutations(self):
  inspection=self.inspect()
  def wrong(ctx,args,body=None,timeout=60):return '{"metadata":{"uid":"source-cluster"}}' if args[:3]==['get','namespaces','kube-system'] else self.command(ctx,args,body,timeout)
  self.assertEqual(self.cleanup(inspection,command=wrong)['status'],'Failed');self.assertEqual(self.deletes(),[])
 def test_uncertain_create_recovery_requires_recorded_uncertainty(self):
  self.receipt['created']=[x for x in self.receipt['created'] if x['kind']!='Deployment'];out=self.inspect();self.assertEqual(out['status'],'Blocked');self.receipt['uncertain']=['Deployment/web'];out=self.inspect();self.assertEqual(out['status'],'ReviewRequired');self.assertEqual(next(x['state'] for x in out['rows'] if x['kind']=='Deployment'),'Recovered');self.assertEqual(self.cleanup(out)['status'],'Absent')
 def test_pending_descendants_prevent_absence_claim(self):
  self.children=[{'kind':'Pod','metadata':{'name':'web-pod','namespace':'app','uid':'pod-uid','labels':{r.LABEL:'run-1'}}}];out=self.cleanup(self.inspect());self.assertEqual(out['status'],'Pending');self.assertEqual(len(out['dependents']),1);self.assertEqual(self.inspect()['status'],'ReviewRequired')
 def test_existing_termination_is_not_forced(self):
  self.objects[('Deployment','web')]['metadata']['deletionTimestamp']=r.now();out=self.cleanup(self.inspect());self.assertEqual(out['status'],'Pending');self.assertEqual(len(self.deletes()),1);self.assertIn('/services/',self.deletes()[0][0][1])
 def test_failed_response_keeps_partial_requests_and_no_retry(self):
  inspection=self.inspect()
  def lost(ctx,args,body=None,timeout=60):
   value=self.command(ctx,args,body,timeout)
   if args[0]=='delete' and '/deployments/' in args[1]:raise RuntimeError('lost response')
   return value
  out=self.cleanup(inspection,command=lost);self.assertEqual(out['status'],'Failed');self.assertEqual([x['outcome'] for x in out['actions']],['Requested','Error']);self.assertEqual(self.objects,{});self.assertEqual(self.inspect()['status'],'Absent')
 def test_label_owner_or_read_error_blocks_cleanup(self):
  self.objects[('Deployment','web')]['metadata']['labels'][r.LABEL]='another-run';self.assertEqual(self.inspect()['status'],'Blocked');self.assertEqual(self.cleanup(self.inspect())['status'],'Failed');self.assertEqual(self.deletes(),[])
  self.objects[('Deployment','web')]['metadata']['labels'][r.LABEL]='run-1';self.objects[('Deployment','web')]['metadata']['ownerReferences']=[{'uid':'new-owner'}];self.assertEqual(self.inspect()['status'],'Blocked')
 def test_null_or_incomplete_reads_are_not_absence(self):
  def malformed(ctx,args,body=None,timeout=60):return 'null' if args[:2]==['get','services'] else self.command(ctx,args,body,timeout)
  with patch.object(r,'command',side_effect=malformed):out=r.recovery_run(self.p,'target',self.receipt,'inspect',self.save)
  self.assertEqual(out['status'],'Blocked');self.assertEqual(next(x['state'] for x in out['rows'] if x['kind']=='Service'),'Error')
 def test_selector_or_persistent_scope_change_needs_manual_review(self):
  self.objects[('Service','web')]['spec']['selector'].pop(r.LABEL);self.assertEqual(self.inspect()['status'],'Blocked');self.objects[('Service','web')]['spec']['selector'][r.LABEL]='run-1';self.objects[('Deployment','web')]['spec']['template']['spec']['volumes']=[{'name':'data','persistentVolumeClaim':{'claimName':'important'}}];self.assertEqual(self.inspect()['status'],'Blocked');self.assertEqual(self.deletes(),[])
 def test_receipt_scope_rejects_unknown_objects(self):
  self.receipt['created'].append({'kind':'Namespace','name':'app','namespace':'','uid':'x'});self.assertRaises(ValueError,self.inspect);self.assertEqual(self.calls,[])
 def test_browser_receipt_compatibility(self):
  inspection=self.inspect();cleanup=self.cleanup(inspection);script="const X=require('./dist/execution'),fs=require('fs'),v=JSON.parse(fs.readFileSync(0,'utf8')); const p=JSON.parse(require('child_process').execFileSync('node',['test-execution.cjs','--fixture'],{encoding:'utf8'})); const r=X.evidence(p,v.receipt),i=X.recoveryEvidence(p,r,v.inspection),c=X.recoveryEvidence(p,r,v.cleanup,i); if(c.status!=='Absent'||c.productionReady)process.exit(1);";out=subprocess.run(['node','-e',script],input=json.dumps({'receipt':self.receipt,'inspection':inspection,'cleanup':cleanup}),capture_output=True,text=True);self.assertEqual(out.returncode,0,out.stderr)
 def test_cleanup_cli_requires_files_and_keeps_exclusive_outputs(self):
  with tempfile.TemporaryDirectory() as directory:
   base=Path(directory);(base/'plan.json').write_text(json.dumps(self.p));(base/'receipt.json').write_text(json.dumps(self.receipt));out=base/'inspection.json';args=['runner','inspect','--context','target','--plan',str(base/'plan.json'),'--receipt',str(base/'receipt.json'),'--output',str(out)]
   with patch.object(r.sys,'argv',args),patch.object(r,'command',side_effect=self.command):self.assertEqual(r.main(),0);self.assertEqual(json.loads(out.read_text())['kind'],'PilotInspectionResult');self.assertRaises(FileExistsError,r.main)
if __name__=='__main__':unittest.main()
