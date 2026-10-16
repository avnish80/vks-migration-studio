"""Deploy must refuse when target routes or autoscalers would reach or scale the pilot,
and the runner must refuse plans that carry reconciler tracking labels."""
import copy,importlib.util,json,unittest,unittest.mock
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

class TrackingLabels(base.Runner):
    def labelled(self,key):
        p=copy.deepcopy(base.FIXTURE);p['preflight']['manifests']['items'][1]['metadata'].setdefault('labels',{})[key]='x'
        p['binding']=json.dumps({k:p[k] for k in ['planRevision','workload','settings','preflight','blockers','prerequisites']});return p
    def test_validate_refuses_tracking_labels(self):
        for key in ['app.kubernetes.io/instance','kustomize.toolkit.fluxcd.io/name']:
            self.p=self.labelled(key);result=self.validation()
            self.assertEqual(result['status'],'Failed');self.assertIn('tracking labels',result['error']);self.assertFalse(any(a[0]=='create' for a,b in self.calls))
    def test_inspect_and_cleanup_still_accept_older_plans(self):
        p=self.labelled('app.kubernetes.io/instance');receipt={'schemaVersion':1,'kind':'PilotExecutionResult','mode':'deploy','status':'Failed','created':[],'uncertain':[],**{k:p[k] for k in ['binding','planRevision','workload']},'context':'target','clusterUID':'target-cluster','runId':'run-1'}
        try:r.receipt_scope(p,'target',receipt)
        except ValueError as e:self.assertNotIn('tracking labels',str(e))
for name in [n for n in dir(base.Runner) if n.startswith('test_')]:
    if name not in TrackingLabels.__dict__:setattr(TrackingLabels,name,None)

class ConsumerEdgeCases(unittest.TestCase):
    def reasons(self,items):return r.consumers(items,'app','web',['web'])
    def test_malformed_objects_do_not_crash(self):
        bad=[None,'x',{'kind':'Ingress','metadata':{'namespace':'app'},'spec':{'rules':[None,{'http':{'paths':[None]}}],'defaultBackend':None}},
             {'kind':'HTTPRoute','metadata':{'namespace':'app'},'spec':{'rules':[None,{'backendRefs':[None],'filters':[None,{'requestMirror':None}]}]}},
             {'kind':'ReferenceGrant','metadata':{'namespace':'app'},'spec':{'to':[None]}},{'kind':'HorizontalPodAutoscaler','metadata':None,'spec':{'scaleTargetRef':None}}]
        self.assertEqual(self.reasons(bad),[])
    def test_request_mirror_and_contour_block(self):
        mirror={'kind':'HTTPRoute','metadata':{'namespace':'app'},'spec':{'rules':[{'backendRefs':[{'name':'api'}],'filters':[{'type':'RequestMirror','requestMirror':{'backendRef':{'name':'web','port':80}}}]}]}}
        contour={'kind':'HTTPProxy','metadata':{'namespace':'app'},'spec':{'routes':[{'services':[{'name':'web','port':80}]}]}}
        self.assertIn('HTTPRoute',' '.join(self.reasons([mirror])));self.assertIn('HTTPProxy',' '.join(self.reasons([contour])))
    def test_partial_discovery(self):
        partial=r.KubectlError('x','services\nhttproutes.gateway.networking.k8s.io\n','error: unable to retrieve the complete list of server APIs: metrics.k8s.io/v1beta1: the server is currently unable to handle the request')
        with unittest.mock.patch.object(r,'command',side_effect=partial):self.assertIn('httproutes.gateway.networking.k8s.io',r.served_resources('target'))
        gateway=r.KubectlError('x','services\n','error: unable to retrieve the complete list of server APIs: gateway.networking.k8s.io/v1: the server is currently unable to handle the request')
        with unittest.mock.patch.object(r,'command',side_effect=gateway),self.assertRaisesRegex(ValueError,'isolation cannot be verified'):r.served_resources('target')
    def test_rbac_failure_is_explained(self):
        def cmd(ctx,args,body=None,timeout=60):
            if args[0]=='api-resources':return ''
            raise r.KubectlError('x','','Error from server (Forbidden)')
        with unittest.mock.patch.object(r,'command',side_effect=cmd),self.assertRaisesRegex(ValueError,'RBAC'):r.isolation(base.FIXTURE,'target','app')

if __name__=='__main__':unittest.main()
