"""Deploy must refuse when target routes or autoscalers would reach or scale the pilot,
and the runner must refuse plans that carry reconciler tracking labels."""
import copy,importlib.util,json,unittest
spec=importlib.util.spec_from_file_location('runner_tests','test-pilot-runner.py');base=importlib.util.module_from_spec(spec);spec.loader.exec_module(base)
r=base.r
INGRESS={'kind':'Ingress','metadata':{'name':'shop','namespace':'app'},'spec':{'rules':[{'http':{'paths':[{'path':'/','backend':{'service':{'name':'web','port':{'number':80}}}}]}}]}}
ROUTE={'kind':'HTTPRoute','metadata':{'name':'shop','namespace':'app'},'spec':{'rules':[{'backendRefs':[{'name':'web','port':80}]}]}}
HPA={'kind':'HorizontalPodAutoscaler','metadata':{'name':'web','namespace':'app'},'spec':{'scaleTargetRef':{'kind':'Deployment','name':'web'},'minReplicas':4}}
KEDA={'kind':'ScaledObject','metadata':{'name':'web','namespace':'app'},'spec':{'scaleTargetRef':{'name':'web'}}}
class Isolation(base.Runner):
    def with_items(self,items,served=''):
        def command(ctx,args,body=None,timeout=60):
            if args[:2]==['api-resources','-o']:return served
            if args[0]=='get' and args[1].startswith('services,'):return json.dumps({'items':items})
            return self.command(ctx,args,body,timeout)
        return command
    def blocked(self,items,served=''):
        validation=self.validation();result,_=self.deploy(validation=validation,command=self.with_items(items,served))
        self.assertEqual(result['status'],'Failed');self.assertEqual(self.objects,{},'no object may be created');return result['error']
    def test_ingress_backend_blocks(self):self.assertIn('Ingress',self.blocked([INGRESS]))
    def test_hpa_blocks(self):self.assertIn('HorizontalPodAutoscaler',self.blocked([HPA]))
    def test_optional_route_and_keda_queried_when_served(self):
        served='httproutes.gateway.networking.k8s.io\nscaledobjects.keda.sh\n'
        seen=[]
        def spy(ctx,args,body=None,timeout=60):
            if args[0]=='get' and args[1].startswith('services,'):seen.append(args[1])
            return self.with_items([ROUTE,KEDA],served)(ctx,args,body,timeout)
        validation=self.validation();result,_=self.deploy(validation=validation,command=spy)
        self.assertEqual(result['status'],'Failed');self.assertIn('HTTPRoute',result['error']);self.assertIn('ScaledObject',result['error'])
        self.assertIn('httproutes.gateway.networking.k8s.io',seen[-1]);self.assertIn('ingresses.networking.k8s.io',seen[-1])
    def test_unqueryable_api_list_fails_closed(self):
        def failing(ctx,args,body=None,timeout=60):
            if args[:2]==['api-resources','-o']:raise RuntimeError('discovery failed')
            return self.command(ctx,args,body,timeout)
        validation=self.validation();result,_=self.deploy(validation=validation,command=failing)
        self.assertEqual(result['status'],'Failed');self.assertIn('isolation cannot be verified',result['error']);self.assertEqual(self.objects,{})
    def test_unrelated_consumers_allow_deploy(self):
        other=copy.deepcopy(INGRESS);other['spec']['rules'][0]['http']['paths'][0]['backend']['service']['name']='api'
        hpa=copy.deepcopy(HPA);hpa['spec']['scaleTargetRef']['name']='api'
        result,_=self.deploy(validation=self.validation(),command=self.with_items([other,hpa]));self.assertEqual(result['status'],'Passed')
    def test_scaled_live_deployment_fails_observation(self):
        def scaled(ctx,args,body=None,timeout=60):
            out=self.command(ctx,args,body,timeout)
            if args[:2]==['get','deployments.apps'] and out:obj=json.loads(out);obj['spec']['replicas']=3;return json.dumps(obj)
            return out
        result,_=self.deploy(validation=self.validation(),command=scaled)
        self.assertEqual(result['status'],'Failed');self.assertIn('single replica',result['error'])
for name in [n for n in dir(base.Runner) if n.startswith('test_')]:
    if name not in Isolation.__dict__:setattr(Isolation,name,None)  # run only the isolation cases here

class TrackingLabels(unittest.TestCase):
    def test_runner_rejects_tracking_labels_in_plan(self):
        for key in ['app.kubernetes.io/instance','kustomize.toolkit.fluxcd.io/name']:
            p=copy.deepcopy(base.FIXTURE);p['preflight']['manifests']['items'][1]['metadata'].setdefault('labels',{})[key]='x'
            p['binding']=json.dumps({k:p[k] for k in ['planRevision','workload','settings','preflight','blockers','prerequisites']})
            with self.assertRaisesRegex(ValueError,'tracking labels'):r.validate_plan(p,'target')
        r.validate_plan(copy.deepcopy(base.FIXTURE),'target')

if __name__=='__main__':unittest.main()
