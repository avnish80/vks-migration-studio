import copy,datetime,http.server,importlib.util,io,json,os,subprocess,tempfile,threading,unittest
from unittest.mock import patch,MagicMock
from pathlib import Path
spec=importlib.util.spec_from_file_location('pilot','dist/pilot-runner.py');r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)
FIXTURE=json.loads(subprocess.check_output(['node','test-execution.cjs','--fixture'],text=True))
class Runner(unittest.TestCase):
 def setUp(self):self.p=copy.deepcopy(FIXTURE);self.objects={};self.saved=[];self.calls=[]
 def save(self,report):self.saved.append(copy.deepcopy(report))
 def command(self,context,args,body=None,timeout=60):
  self.assertEqual(context,'target');self.calls.append((args,body))
  if args[:3]==['get','namespaces','kube-system']:return json.dumps({'metadata':{'uid':'target-cluster'}})
  if args[0]=='get' and args[1].startswith('services,'):return '{"items":[]}'
  if args[0]=='create':
   obj=json.loads(body)
   if '--dry-run=server' in args:return 'dry-run'
   self.assertTrue(self.saved[-1]['uncertain'],'Receipt must precede persistent create');obj['metadata']['uid']=obj['kind']+'-uid';self.objects[obj['kind']]=obj;return json.dumps(obj)
  if args[:2]==['rollout','status']:return 'complete'
  if args[:2]==['get','deployments.apps']:return json.dumps(self.objects['Deployment']) if 'Deployment' in self.objects else ''
  if args[:2]==['get','replicasets.apps']:return json.dumps({'items':[{'metadata':{'uid':'rs-uid','ownerReferences':[{'uid':'Deployment-uid','controller':True}]}}]})
  if args[:2]==['get','pods']:
   d=self.objects['Deployment'];pod={'metadata':{'name':'web-pod','labels':{r.LABEL:d['metadata']['labels'][r.LABEL]},'ownerReferences':[{'uid':'rs-uid','controller':True}]},'spec':d['spec']['template']['spec'],'status':{'conditions':[{'type':'Ready','status':'True'}],'containerStatuses':[{'name':'web','image':d['spec']['template']['spec']['containers'][0]['image'],'imageID':'containerd://sha256:'+'b'*64,'ready':True}]}};return json.dumps({'items':[pod]})
  return ''
 def validation(self):
  with patch.object(r.preflight,'run',return_value={'results':[{'status':'Pass'}]}),patch.object(r,'command',side_effect=self.command):return r.run(self.p,'target','validate',self.save)
 def deploy(self,**kwargs):
  validation=kwargs.pop('validation',None) or self.validation()
  with patch.object(r.preflight,'run',return_value={'results':[{'status':'Pass'}]}),patch.object(r,'command',side_effect=kwargs.pop('command',self.command)),patch.object(r,'smoke',return_value={'status':'Pass','detail':'Approved status/latency matched'}) as smoke:
   report=r.run(self.p,'target','deploy',self.save,validation,kwargs.pop('confirm',self.p['workload']),kwargs.pop('ack',True));return report,smoke
 def test_validation_has_no_persistent_writes(self):
  result=self.validation();self.assertEqual(result['status'],'Passed');self.assertEqual(result['created'],[]);self.assertFalse(any(a[0]=='create' and '--dry-run=server' not in a for a,b in self.calls));self.assertTrue(any(a[0]=='create' and '--dry-run=server' in a for a,b in self.calls))
 def test_create_only_rollout_images_and_smoke(self):
  result,smoke=self.deploy();self.assertEqual(result['status'],'Passed');self.assertEqual(len(result['created']),2);self.assertEqual(result['images'][0]['container'],'web');self.assertEqual(result['smoke']['status'],'Pass');self.assertFalse(result['productionReady']);self.assertTrue(smoke.called);self.assertEqual(list(self.objects),['Service','Deployment']);self.assertNotIn('delete',[a[0] for a,b in self.calls]);self.assertNotIn('apply',[a[0] for a,b in self.calls]);d=self.objects['Deployment'];self.assertEqual(d['spec']['selector']['matchLabels'][r.LABEL],result['runId']);self.assertEqual(self.objects['Service']['spec']['selector'][r.LABEL],result['runId']);self.assertGreater(len(self.saved),5)
 def test_confirmation_and_stale_validation_block_creates(self):
  result,_=self.deploy(ack=False);self.assertEqual(result['status'],'Failed');self.assertEqual(self.objects,{})
  validation=self.validation();validation['observedAt']='2000-01-01T00:00:00Z';result,_=self.deploy(validation=validation);self.assertEqual(result['status'],'Failed');self.assertEqual(self.objects,{})
 def test_same_name_overlap_or_wrong_cluster_blocks_deploy(self):
  validation=self.validation()
  def wrong(ctx,args,body=None,timeout=60):return '{"metadata":{"uid":"source-cluster"}}' if args[:3]==['get','namespaces','kube-system'] else self.command(ctx,args,body,timeout)
  result,_=self.deploy(validation=validation,command=wrong);self.assertEqual(result['status'],'Failed');self.assertEqual(self.objects,{})
  def overlap(ctx,args,body=None,timeout=60):return json.dumps({'items':[{'kind':'Service','metadata':{},'spec':{'selector':{'app':'web'}}}]}) if args[0]=='get' and args[1].startswith('services,') else self.command(ctx,args,body,timeout)
  result,_=self.deploy(validation=validation,command=overlap);self.assertEqual(result['status'],'Failed');self.assertEqual(self.objects,{})
 def test_unresolved_preflight_blocks_create(self):
  with patch.object(r.preflight,'run',return_value={'results':[{'status':'Error'}]}),patch.object(r,'command',side_effect=self.command):out=r.run(self.p,'target','validate',self.save)
  self.assertEqual(out['status'],'Failed');self.assertFalse(any(a[0]=='create' for a,b in self.calls))
 def test_create_response_failure_keeps_partial_receipt_and_recovers_uid(self):
  validation=self.validation()
  def uncertain(ctx,args,body=None,timeout=60):
   result=self.command(ctx,args,body,timeout)
   if args[0]=='create' and '--dry-run=server' not in args and json.loads(body)['kind']=='Deployment':raise RuntimeError('RAW_SECRET_DIAGNOSTIC')
   return result
  out,_=self.deploy(validation=validation,command=uncertain);self.assertEqual(out['status'],'Failed');self.assertEqual(len(out['created']),2);self.assertIn('Deployment/web',out['uncertain']);self.assertNotIn('RAW_SECRET_DIAGNOSTIC',json.dumps(out));self.assertNotIn('delete',[a[0] for a,b in self.calls])
 def test_rollout_failure_retains_created_objects(self):
  validation=self.validation()
  def fail(ctx,args,body=None,timeout=60):
   if args[:2]==['rollout','status']:raise RuntimeError('timeout')
   return self.command(ctx,args,body,timeout)
  out,smoke=self.deploy(validation=validation,command=fail);self.assertEqual(out['status'],'Failed');self.assertEqual(out['rollout']['status'],'Error');self.assertEqual(len(out['created']),2);smoke.assert_not_called()
 def test_failed_image_startup_is_recorded_without_smoke(self):
  validation=self.validation()
  def pull_error(ctx,args,body=None,timeout=60):
   result=self.command(ctx,args,body,timeout)
   if args[:2]==['get','pods']:
    obj=json.loads(result);pod=obj['items'][0];pod['status']['conditions'][0]['status']='False';status=pod['status']['containerStatuses'][0];status.update(ready=False,imageID='',state={'waiting':{'reason':'ImagePullBackOff','message':'RAW_SECRET_DIAGNOSTIC'}});return json.dumps(obj)
   return result
  out,smoke=self.deploy(validation=validation,command=pull_error);self.assertEqual(out['status'],'Failed');self.assertEqual(out['images'][0]['reason'],'ImagePullBackOff');self.assertNotIn('RAW_SECRET_DIAGNOSTIC',json.dumps(out));smoke.assert_not_called()
 def test_http_probe_disables_redirects_and_omits_body(self):
  requests=[]
  class Handler(http.server.BaseHTTPRequestHandler):
   def do_GET(self):
    requests.append(self.path);self.send_response(302 if self.path=='/redirect' else 200)
    if self.path=='/redirect':self.send_header('Location','http://127.0.0.1:'+str(self.server.server_port)+'/followed')
    self.end_headers();self.wfile.write(b'SUPER_SECRET_BODY')
   def log_message(self,*args):pass
  server=http.server.HTTPServer(('127.0.0.1',0),Handler);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
  try:
   settings={**self.p['settings'],'smokePath':'/redirect'};out=r.http_check(server.server_port,settings);self.assertEqual(out['status'],'Fail');self.assertEqual(requests,['/redirect']);self.assertNotIn('SUPER_SECRET_BODY',json.dumps(out));settings.update(smokePath='/health',smokeMarker='SUPER_SECRET_BODY');self.assertEqual(r.http_check(server.server_port,settings)['status'],'Pass')
  finally:server.shutdown();server.server_close();thread.join(timeout=2)
 def test_generated_result_imports_into_browser_module(self):
  result,_=self.deploy();script="const X=require('./dist/execution'),fs=require('fs'); const p=JSON.parse(require('child_process').execFileSync('node',['test-execution.cjs','--fixture'],{encoding:'utf8'})); const e=X.evidence(p,JSON.parse(fs.readFileSync(0,'utf8'))); if(e.status!=='Passed'||e.productionReady)process.exit(1);";out=subprocess.run(['node','-e',script],input=json.dumps(result),capture_output=True,text=True);self.assertEqual(out.returncode,0,out.stderr)
 def test_mutated_plan_and_unsupported_resources_fail_before_calls(self):
  self.p['settings']['smokePath']='/changed';self.assertRaises(ValueError,r.run,self.p,'target','validate',self.save);self.assertEqual(self.calls,[])
 def test_context_forwarding_no_shell(self):
  fake=subprocess.CompletedProcess([],0,stdout='ok',stderr='')
  with patch.object(r.subprocess,'run',return_value=fake) as call:r.command('target',['get','pods'])
  args=call.call_args.args[0];self.assertIn('--context=target',args);self.assertNotIn('shell',call.call_args.kwargs)
 def test_port_forward_is_loopback_and_terminated_on_error(self):
  proc=MagicMock();proc.stdout=io.StringIO('Forwarding from 127.0.0.1:12345 -> 8080\n')
  with patch.object(r.subprocess,'Popen',return_value=proc) as popen,patch.object(r,'http_check',side_effect=RuntimeError('probe failed')):
   self.assertRaises(RuntimeError,r.smoke,'target','app','web-pod',self.p['settings']);self.assertIn('--address=127.0.0.1',popen.call_args.args[0]);proc.terminate.assert_called_once()
 def test_output_exclusive_and_private(self):
  with tempfile.TemporaryDirectory() as directory:
   plan=Path(directory)/'plan.json';plan.write_text(json.dumps(self.p));output=Path(directory)/'run.json';args=['runner','validate','--context','target','--plan',str(plan),'--output',str(output)]
   with patch.object(r.sys,'argv',args),patch.object(r.preflight,'run',return_value={'results':[{'status':'Pass'}]}),patch.object(r,'command',side_effect=self.command):self.assertEqual(r.main(),0);self.assertEqual(os.stat(output).st_mode&0o777,0o600);self.assertEqual(json.loads(output.read_text())['status'],'Passed');self.assertRaises(FileExistsError,r.main)
if __name__=='__main__':unittest.main()
