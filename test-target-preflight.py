import importlib.util,json,subprocess,unittest
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('target','dist/target-preflight.py');t=importlib.util.module_from_spec(spec);spec.loader.exec_module(t)
class Checks(unittest.TestCase):
 def plan(self):return {'schemaVersion':1,'planRevision':'rev','expectedContext':'target','sourceClusterUID':'source','expectedClusterUID':'target','blockers':[],'manifests':{'items':[{'apiVersion':'apps/v1','kind':'Deployment','metadata':{'name':'web','namespace':'app'}}]},'checks':[{'id':'identity','type':'identity'},{'id':'apis','type':'apis','required':['apps/v1']},{'id':'nodes','type':'nodes'},{'id':'namespace:app','type':'namespace','namespace':'app'},{'id':'available:web','type':'available','kind':'Deployment','name':'web','namespace':'app'},{'id':'ref:secret','type':'reference','kind':'Secret','name':'credential','namespace':'app'},{'id':'dry-run','type':'dryrun'}]}
 def respond(self,context,args,body=None):
  if args[0]=='api-versions':return 'v1\napps/v1\n'
  if args[:2]==['get','nodes']:return json.dumps({'items':[{'spec':{},'status':{'conditions':[{'type':'Ready','status':'True'}]}}]})
  if args[:3]==['get','namespaces','kube-system']:return json.dumps({'metadata':{'uid':'target'}})
  if args[:3]==['get','namespaces','app']:return json.dumps({'metadata':{},'status':{'phase':'Active'}})
  if args[:2]==['get','secrets']:return 'secret/credential'
  return ''
 def test_scoped_reads_and_server_dryrun(self):
  with patch.object(t,'command',side_effect=self.respond) as call:
   r=t.run(self.plan(),'target');self.assertTrue(all(x['status']=='Pass' for x in r['results']));apply=[c for c in call.call_args_list if c.args[1][0]=='apply'];self.assertEqual(len(apply),1);self.assertIn('--dry-run=server',apply[0].args[1]);self.assertNotIn('password',json.dumps(r));self.assertFalse(r['productionReady'])
 def test_wrong_cluster_skips_dryrun(self):
  def response(ctx,args,body=None):return json.dumps({'metadata':{'uid':'source'}}) if args[:3]==['get','namespaces','kube-system'] else self.respond(ctx,args,body)
  with patch.object(t,'command',side_effect=response) as call:
   r=t.run(self.plan(),'target');self.assertEqual(r['results'][0]['status'],'Fail');self.assertEqual(r['results'][-1]['status'],'Skipped');self.assertFalse(any(c.args[1][0]=='apply' for c in call.call_args_list))
 def test_absence_is_distinct_from_forbidden(self):
  def absent(ctx,args,body=None):return '' if args[:2]==['get','secrets'] else self.respond(ctx,args,body)
  with patch.object(t,'command',side_effect=absent):r=t.run(self.plan(),'target');self.assertEqual(r['results'][-2]['status'],'Fail');self.assertEqual(r['results'][-1]['status'],'Skipped')
  def denied(ctx,args,body=None):
   if args[:2]==['get','secrets']:raise RuntimeError('Read forbidden')
   return self.respond(ctx,args,body)
  with patch.object(t,'command',side_effect=denied):self.assertEqual(t.run(self.plan(),'target')['results'][-2]['status'],'Error')
 def test_cordoned_nodes_are_not_a_pass(self):
  def response(ctx,args,body=None):return json.dumps({'items':[{'spec':{'unschedulable':True},'status':{'conditions':[{'type':'Ready','status':'True'}]}}]}) if args[:2]==['get','nodes'] else self.respond(ctx,args,body)
  with patch.object(t,'command',side_effect=response):self.assertEqual(t.run(self.plan(),'target')['results'][2]['status'],'Fail')
 def test_known_blockers_prevent_dryrun(self):
  p=self.plan();p['blockers']=[{'reason':'Missing value'}]
  with patch.object(t,'command',side_effect=self.respond) as call:self.assertEqual(t.run(p,'target')['results'][-1]['status'],'Skipped');self.assertFalse(any(c.args[1][0]=='apply' for c in call.call_args_list))
 def test_context_and_order_are_checked(self):
  with self.assertRaises(ValueError):t.run(self.plan(),'wrong')
  p=self.plan();p['checks'].reverse()
  with self.assertRaises(ValueError):t.run(p,'target')
 def test_gateway_current_generation_required(self):
  p=self.plan();p['checks'].insert(-1,{'id':'gateway','type':'gateway','name':'gw','namespace':'infra','listener':'https'})
  def response(ctx,args,body=None):return json.dumps({'metadata':{'generation':2},'spec':{'listeners':[{'name':'https'}]},'status':{'conditions':[{'type':'Programmed','observedGeneration':1,'status':'True'}]}}) if args[:2]==['get','gateways.gateway.networking.k8s.io'] else self.respond(ctx,args,body)
  with patch.object(t,'command',side_effect=response):self.assertEqual(t.run(p,'target')['results'][-2]['status'],'Unknown')
 def test_no_context_switch_shell_or_raw_diagnostics(self):
  with patch.object(t.subprocess,'run',return_value=subprocess.CompletedProcess([],1,'','SECRET_DIAGNOSTIC')) as call:
   with self.assertRaises(RuntimeError) as caught:t.command('target; literal',['get','nodes','-o','json'])
   self.assertNotIn('SECRET_DIAGNOSTIC',str(caught.exception));self.assertIn('--context=target; literal',call.call_args.args[0]);self.assertNotIn('shell',call.call_args.kwargs)
unittest.main()
