// Existing target routes and autoscalers must block the isolated one-replica pilot.
const assert=require('node:assert/strict'),fs=require('node:fs'),X=require('./dist/execution'),P=require('./dist/pilot');
const src=fs.readFileSync('./test-execution.cjs','utf8');
const fixture=new Function('require',src.slice(src.indexOf('const digest'),src.indexOf('const plan='))+';return {source,target,options};')(require);
const {source,target,options}=fixture;
const reasons=extra=>{const t=structuredClone(target);t.items.push(...extra);return X.plan(source,t,options).blockers.map(b=>b.reason).join('\n');};
assert.equal(X.plan(source,target,options).blockers.length,0,'baseline plan must be unblocked');
const consumers={
 ingress:{apiVersion:'networking.k8s.io/v1',kind:'Ingress',metadata:{name:'shop',namespace:'app'},spec:{rules:[{host:'shop.example.com',http:{paths:[{path:'/',pathType:'Prefix',backend:{service:{name:'web',port:{number:80}}}}]}}]}},
 defaultBackend:{apiVersion:'networking.k8s.io/v1',kind:'Ingress',metadata:{name:'catch',namespace:'app'},spec:{defaultBackend:{service:{name:'web',port:{number:80}}}}},
 httproute:{apiVersion:'gateway.networking.k8s.io/v1',kind:'HTTPRoute',metadata:{name:'shop',namespace:'app'},spec:{rules:[{backendRefs:[{name:'web',port:80}]}]}},
 grpcroute:{apiVersion:'gateway.networking.k8s.io/v1',kind:'GRPCRoute',metadata:{name:'rpc',namespace:'app'},spec:{rules:[{backendRefs:[{kind:'Service',name:'web',port:80}]}]}},
 referencegrant:{apiVersion:'gateway.networking.k8s.io/v1beta1',kind:'ReferenceGrant',metadata:{name:'allow',namespace:'app'},spec:{from:[{group:'gateway.networking.k8s.io',kind:'HTTPRoute',namespace:'edge'}],to:[{group:'',kind:'Service'}]}},
 hpa:{apiVersion:'autoscaling/v2',kind:'HorizontalPodAutoscaler',metadata:{name:'web',namespace:'app'},spec:{scaleTargetRef:{apiVersion:'apps/v1',kind:'Deployment',name:'web'},minReplicas:4,maxReplicas:8}},
 keda:{apiVersion:'keda.sh/v1alpha1',kind:'ScaledObject',metadata:{name:'web',namespace:'app'},spec:{scaleTargetRef:{name:'web'}}},
 vpa:{apiVersion:'autoscaling.k8s.io/v1',kind:'VerticalPodAutoscaler',metadata:{name:'web',namespace:'app'},spec:{targetRef:{apiVersion:'apps/v1',kind:'Deployment',name:'web'}}}
};
for(const [name,obj] of Object.entries(consumers))assert.match(reasons([obj]),/route|ReferenceGrant|targets Deployment/,name+' must block the pilot');
// Unrelated objects must not block.
const unrelated=[
 {...structuredClone(consumers.ingress),metadata:{name:'other',namespace:'app'},spec:{rules:[{http:{paths:[{path:'/',pathType:'Prefix',backend:{service:{name:'api',port:{number:80}}}}]}}]}},
 {...structuredClone(consumers.ingress),metadata:{name:'shop',namespace:'elsewhere'}},
 {...structuredClone(consumers.httproute),spec:{rules:[{backendRefs:[{name:'web',namespace:'elsewhere',port:80}]}]}},
 {...structuredClone(consumers.hpa),spec:{scaleTargetRef:{kind:'Deployment',name:'api'}}},
 {...structuredClone(consumers.hpa),spec:{scaleTargetRef:{kind:'StatefulSet',name:'web'}}},
 {...structuredClone(consumers.referencegrant),spec:{to:[{group:'',kind:'Service',name:'api'}]}}
];
assert.equal(X.plan(source,{...target,items:[...target.items,...unrelated]},options).blockers.length,0,'unrelated routes and autoscalers must not block');
// Robust against malformed target objects.
assert.deepEqual(P.targetConsumers({items:[{kind:'Ingress',metadata:{name:'x',namespace:'app'},spec:{rules:'bad'}},{kind:'HTTPRoute',metadata:{name:'y',namespace:'app'}}]},'app','web',['web']),[]);
// Null entries anywhere in route or autoscaler specs must not throw (they used to crash three views).
assert.deepEqual(P.targetConsumers({items:[null,{kind:'Ingress',metadata:{name:'a',namespace:'app'},spec:{rules:[null,{http:{paths:[null]}}],defaultBackend:null}},{kind:'HTTPRoute',metadata:{name:'b',namespace:'app'},spec:{rules:[null,{backendRefs:[null],filters:[null,{requestMirror:null}]}]}},{kind:'ReferenceGrant',metadata:{name:'c',namespace:'app'},spec:{to:[null]}},{kind:'HorizontalPodAutoscaler',metadata:{name:'d',namespace:'app'},spec:{scaleTargetRef:null}}]},'app','web',['web']),[]);
assert.equal(X.plan(source,{...target,items:[...target.items,{apiVersion:'networking.k8s.io/v1',kind:'Ingress',metadata:{name:'n',namespace:'app'},spec:{rules:[null]}}]},options).blockers.length,0);
// Mirrored traffic and Contour HTTPProxy (the usual VKS ingress package) also count.
assert.match(reasons([{apiVersion:'gateway.networking.k8s.io/v1',kind:'HTTPRoute',metadata:{name:'m',namespace:'app'},spec:{rules:[{backendRefs:[{name:'api',port:80}],filters:[{type:'RequestMirror',requestMirror:{backendRef:{name:'web',port:80}}}]}]}}]),/HTTPRoute routes to Service web/);
assert.match(reasons([{apiVersion:'projectcontour.io/v1',kind:'HTTPProxy',metadata:{name:'p',namespace:'app'},spec:{virtualhost:{fqdn:'shop.example.com'},routes:[{services:[{name:'web',port:80}]}]}}]),/HTTPProxy routes to Service web/);
console.log('Isolation tests passed: Ingress, default backend, Gateway routes and mirrors, Contour HTTPProxy, ReferenceGrant, HPA, KEDA and VPA consumers block; unrelated and other-namespace objects do not.');
