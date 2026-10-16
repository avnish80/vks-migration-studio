// Inherited Argo CD, Helm and Flux tracking labels must not reach the target.
const assert=require('node:assert/strict'),fs=require('node:fs'),X=require('./dist/execution'),R=require('./dist/routing'),E=require('./dist/engine');
const src=fs.readFileSync('./test-execution.cjs','utf8');
const {source,target,options}=new Function('require',src.slice(src.indexOf('const digest'),src.indexOf('const plan='))+';return {source,target,options};')(require);
const tracking={'app.kubernetes.io/instance':'payments-src','app.kubernetes.io/managed-by':'Helm','helm.sh/chart':'web-1.2.0','kustomize.toolkit.fluxcd.io/name':'apps','helm.toolkit.fluxcd.io/name':'web','app':'web','team':'payments'};
for(const key of Object.keys(tracking))assert.equal(E.ownershipLabel(key),!['app','team'].includes(key),key);
const s=structuredClone(source),dep=s.items[1],svc=s.items[2];
dep.metadata.labels={...tracking};svc.metadata.labels={...tracking};
// The instance label is also used in pod template labels and selectors; those must survive.
dep.spec.selector.matchLabels['app.kubernetes.io/instance']='payments-src';dep.spec.template.metadata.labels['app.kubernetes.io/instance']='payments-src';svc.spec.selector['app.kubernetes.io/instance']='payments-src';
const plan=X.plan(s,target,options);
assert.equal(plan.blockers.length,0,JSON.stringify(plan.blockers));
for(const r of plan.preflight.manifests.items){assert.deepEqual(r.metadata.labels,{app:'web',team:'payments'},r.kind+' keeps only non-tracking labels');}
const d=plan.preflight.manifests.items.find(r=>r.kind==='Deployment'),service=plan.preflight.manifests.items.find(r=>r.kind==='Service');
assert.equal(d.spec.template.metadata.labels['app.kubernetes.io/instance'],'payments-src');assert.equal(d.spec.selector.matchLabels['app.kubernetes.io/instance'],'payments-src');assert.equal(service.spec.selector['app.kubernetes.io/instance'],'payments-src');
// Routing output strips the same labels.
const ingress={apiVersion:'networking.k8s.io/v1',kind:'Ingress',metadata:{name:'web',namespace:'app',labels:{...tracking}},spec:{ingressClassName:'source',rules:[{host:'a.example.com',http:{paths:[{path:'/',pathType:'Prefix',backend:{service:{name:'web',port:{number:80}}}}]}}]}};
const routed=R.generate({items:[ingress,{apiVersion:'v1',kind:'Service',metadata:{name:'web',namespace:'app'},spec:{ports:[{port:80}]}}]},{source:'app/Ingress/web',mode:'Ingress',ingressClass:'avi'});
for(const r of routed.manifests.items)assert(!Object.keys(r.metadata.labels||{}).some(E.ownershipLabel),r.kind+' route keeps a tracking label');
console.log('Ownership label tests passed: Argo/Helm/Flux tracking labels stripped from pilot and routes, selectors and template labels preserved.');
