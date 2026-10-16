(function(root){
'use strict';
const E=root.MigrationEngine||(typeof require!=='undefined'?require('./engine.js'):null),copy=x=>JSON.parse(JSON.stringify(x));
const ns=r=>r.metadata.namespace||'default';
const label=x=>typeof x==='string'&&x.length<=63&&/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(x);
const dns=x=>typeof x==='string'&&x.length<=253&&/^[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?$/.test(x);
function candidates(raw){return E.normalize(raw).items.filter(r=>r.kind==='Ingress').map(r=>({id:E.id(r),name:r.metadata.name,namespace:ns(r)}));}
function selectorMatches(selector,labels){if(!selector)return false;return Object.entries(selector.matchLabels||{}).every(([k,v])=>labels[k]===v)&&(selector.matchExpressions||[]).every(e=>e.operator==='In'?(e.values||[]).includes(labels[e.key]):e.operator==='NotIn'?!(e.values||[]).includes(labels[e.key]):e.operator==='Exists'?e.key in labels:e.operator==='DoesNotExist'?!(e.key in labels):false);}
function generate(raw,options={}){
 const source=E.normalize(raw),target=options.target?E.normalize(options.target):null,r=source.items.find(x=>E.id(x)===options.source),blockers=[],prerequisites=[],changes=[],tests=[],untranslated=[];
 const manifests={apiVersion:'v1',kind:'List',items:[]},block=reason=>blockers.push({resource:options.source,reason}),need=(resource,action)=>{if(!prerequisites.some(x=>x.resource===resource&&x.action===action))prerequisites.push({resource,action,status:'Unverified'});};
 const mode=options.mode||'Ingress';
 if(!r||r.kind!=='Ingress'){block('Select a source Ingress. Existing Gateway/HTTPRoute objects and proprietary API gateway CRs require separate adapters.');return finish();}
 if(r.apiVersion!=='networking.k8s.io/v1'){block('Only networking.k8s.io/v1 Ingress is supported. Upgrade desired state before conversion.');return finish();}
 if(!['Ingress','HTTPRoute'].includes(mode)){block('Select Ingress or HTTPRoute output.');return finish();}
 const namespace=ns(r),spec=copy(r.spec||{}),annotations=r.metadata.annotations||{};
 if(r.metadata.ownerReferences?.length)block('Source Ingress is owned by another controller. Migrate the owning desired-state object and lifecycle.');
 for(const key of Object.keys(annotations)){
  if(key==='kubernetes.io/ingress.class'||/^(kubectl.kubernetes.io\/last-applied-configuration|meta.helm.sh\/|argocd.argoproj.io\/tracking-id)/.test(key))continue;
  untranslated.push(key);block('Annotation requires explicit destination implementation mapping: '+key);
 }
 changes.push({path:'metadata',before:'Source runtime metadata and annotations',after:'New resource metadata; annotations omitted and non-bookkeeping keys explicitly blocked'});
 const metadata=name=>({name,namespace,labels:Object.fromEntries(Object.entries(r.metadata.labels||{}).filter(([k])=>!['argocd.argoproj.io/instance','app.kubernetes.io/managed-by'].includes(k)))});
 const backends=new Map();
 const services=(target?.items||[]).filter(x=>x.kind==='Service'&&ns(x)===namespace);
 function backend(b){if(b?.resource){block('Custom resource backend cannot be translated to a core Service reference.');return null;}const s=b?.service;if(!s?.name||!dns(s.name)){block('Backend Service name missing or invalid.');return null;}const observed=source.items.find(x=>x.kind==='Service'&&ns(x)===namespace&&x.metadata.name===s.name);let port=s.port?.number;
  if(s.port?.name){port=observed?.spec?.ports?.find(p=>p.name===s.port.name)?.port;if(!port)block('Named Service port cannot be resolved from source inventory: '+s.name+'/'+s.port.name);}
  if(!Number.isInteger(port)||port<1||port>65535){block('Backend Service port unresolved or invalid: '+s.name);return null;}
  const destination=services.find(x=>x.metadata.name===s.name);if(destination&&!destination.spec?.ports?.some(x=>x.port===port))block('Observed target Service does not expose required port '+s.name+':'+port);
  need(namespace+'/Service/'+s.name,'Provision Service port '+port+', endpoints and backend protocol. Validate health and target connectivity; a resource existing does not establish reachability.');
  return {name:s.name,port};
 }
 for(const rule of spec.rules||[])for(const path of rule.http?.paths||[]){const b=backend(path.backend);backends.set(path,b);if(!['Prefix','Exact'].includes(path.pathType))block('ImplementationSpecific or missing pathType requires controller-specific translation.');if(typeof path.path!=='string'||!path.path.startsWith('/'))block('Path must be an explicit absolute path.');tests.push({host:rule.host||'<any host>',path:path.path||'<unspecified>',match:path.pathType||'Unspecified',expectedBackend:b?b.name+':'+b.port:'Unresolved',status:'Not run'});}
 if(mode==='Ingress'){
  if(!dns(options.ingressClass))block('Choose an explicit destination IngressClass.');else{spec.ingressClassName=options.ingressClass;const c=target?.items.find(x=>x.kind==='IngressClass'&&x.metadata.name===options.ingressClass);need('IngressClass/'+options.ingressClass,c?'Observed class controller '+(c.spec?.controller||'unspecified')+'. Verify controller health and supported semantics.':'Class not observed; provision and verify it before route validation.');if(target?.collection?.queriedResources?.includes('ingressclasses')&&!target.collection.errors?.some(e=>e.resource==='ingressclasses')&&!c)block('Destination IngressClass absent from successfully queried target inventory.');}
  if(spec.defaultBackend)backend(spec.defaultBackend);
  for(const tls of spec.tls||[])need(namespace+'/Secret/'+(tls.secretName||'<controller default>'),'Provision and verify TLS certificate/key, host coverage, renewal and secret access. Certificates are never copied.');
  manifests.items.push({apiVersion:'networking.k8s.io/v1',kind:'Ingress',metadata:metadata(r.metadata.name),spec});changes.push({path:'spec.ingressClassName',before:r.spec?.ingressClassName||annotations['kubernetes.io/ingress.class']||'Default',after:options.ingressClass||'Unresolved'});
 }else{
  const gatewayNS=options.gatewayNamespace||namespace,gwName=options.gateway,section=options.listener;
  if(!dns(gwName)||!label(gatewayNS)||!label(section))block('Supply an explicit destination Gateway name, namespace and listener section name.');
  const gw=target?.items.find(x=>x.kind==='Gateway'&&ns(x)===gatewayNS&&x.metadata.name===gwName),listener=gw?.spec?.listeners?.find(x=>x.name===section);
  need(gatewayNS+'/Gateway/'+(gwName||'<unmapped>'),gw?'Observed Gateway. Verify GatewayClass/controller, Programmed status and address readiness outside this inventory.':'Gateway not observed. Import target evidence and prepare the intended Gateway/listener. This draft does not create or modify it.');
  if(target?.collection?.queriedResources?.includes('gateways.gateway.networking.k8s.io')&&!target.collection.errors?.some(e=>e.resource==='gateways.gateway.networking.k8s.io')&&!gw)block('Destination Gateway absent from successfully queried target inventory.');
  if(gw&&!listener)block('Selected listener not found on the observed target Gateway.');
  if(listener){if(!['HTTP','HTTPS'].includes(listener.protocol))block('Selected listener protocol cannot attach HTTPRoutes: '+listener.protocol);
   const kinds=listener.allowedRoutes?.kinds;if(kinds?.length&&!kinds.some(k=>k.kind==='HTTPRoute'&&(!k.group||k.group==='gateway.networking.k8s.io')))block('Listener allowedRoutes.kinds excludes HTTPRoute.');
   const allowed=listener.allowedRoutes?.namespaces?.from||'Same';if(allowed==='Same'&&gatewayNS!==namespace)block('Listener permits same-namespace routes only; cross-namespace attachment is denied.');
   if(allowed==='Selector'){const destNS=target?.items.find(x=>x.kind==='Namespace'&&x.metadata.name===namespace);if(destNS&&!selectorMatches(listener.allowedRoutes.namespaces.selector,destNS.metadata.labels||{}))block('Destination namespace labels do not satisfy the listener allowedRoutes selector.');else if(!destNS)need('Namespace/'+namespace,'Collect target namespace labels and validate the listener allowedRoutes selector.');}
   if(listener.protocol==='HTTPS'){if(listener.tls?.mode&&listener.tls.mode!=='Terminate')block('HTTPRoute requires HTTPS termination; passthrough is not translated.');if(!listener.tls?.certificateRefs?.length)block('HTTPS listener has no observed certificate references.');need('Listener TLS','Verify certificate SANs, secrets, cross-namespace certificate ReferenceGrants where required, renewal, trust, HTTPS behavior and any HTTP-to-HTTPS redirect. Listener TLS remains infrastructure-owned.');}
   if(spec.tls?.length&&listener.protocol!=='HTTPS')block('Source TLS would be lost on the selected HTTP listener. Select an HTTPS terminating listener and map certificates.');
  }
  if(spec.tls?.length)need('Source TLS migration','Map source TLS hosts and secret references to the destination Gateway listener certificate configuration; no TLS secrets are exported.');
  if(spec.tls?.length)changes.push({path:'spec.tls',before:'Ingress TLS secret references',after:'Not embedded in HTTPRoute; mapped Gateway listener must terminate TLS with equivalent certificates'});
  if(spec.defaultBackend)block('Ingress defaultBackend needs explicit fallback scope/precedence review. No catch-all HTTPRoute is generated automatically.');
  for(const [i,rule] of (spec.rules||[]).entries()){
   if(rule.host?.startsWith('*.'))block('Wildcard host matching differs between Ingress and Gateway API. Review the destination hostname scope explicitly.');
   const routeRules=[];for(const path of rule.http?.paths||[]){const b=backends.get(path);if(!b||!['Exact','Prefix'].includes(path.pathType)||typeof path.path!=='string'||!path.path.startsWith('/'))continue;routeRules.push({matches:[{path:{type:path.pathType==='Prefix'?'PathPrefix':'Exact',value:path.path}}],backendRefs:[{name:b.name,port:b.port}]});}
   if(!routeRules.length){block('No supported routing paths for source host '+(rule.host||'<any>'));continue;}
   if(listener?.hostname&&(!rule.host||!hostSubset(rule.host,listener.hostname)))block('Route host scope is not fully covered by the selected listener hostname: '+(rule.host||'<any>')+' → '+listener.hostname);
   const name=r.metadata.name.slice(0,240).replace(/-+$/,'')+'-r'+(i+1),parent={name:gwName||'UNMAPPED',namespace:gatewayNS,sectionName:section||'UNMAPPED'};
   manifests.items.push({apiVersion:'gateway.networking.k8s.io/v1',kind:'HTTPRoute',metadata:metadata(name),spec:{parentRefs:[parent],...(rule.host?{hostnames:[rule.host]}:{}),rules:routeRules}});
  }
  changes.push({path:'kind / host rules / paths',before:'Ingress with host-specific paths',after:'Separate HTTPRoute per source host; Prefix → PathPrefix, Exact → Exact; named ports resolved to Service port numbers'});
 }
 if(!manifests.items.length)block('No draft routing resources generated.');
 for(const m of manifests.items){if(target?.items.some(x=>E.id(x)===E.id(m)))block('Same-named target resource exists: '+E.id(m)+'. Resolve ownership and merge intent.');if(target?.collection?.apiDiscoveryComplete&&!target.collection.apiVersions?.includes(m.apiVersion))block('Target does not advertise '+m.apiVersion);}
 need('Traffic and security parity','Test host/path routing and precedence, rewrites, redirects, timeouts, auth, rate limits, WAF, TLS and both permitted/denied requests. Annotation removal is never assumed equivalent.');
 need('DNS and controlled cutover','Verify address reachability, split DNS, TTL, ExternalDNS ownership, certificate readiness and rollback. No DNS, traffic or source route is changed by this generator.');
 need('Desired-state ownership','Promote reviewed changes through the owning Helm/Argo/Flux repository. Keep source routing until approved validation and cutover.');
 need('Target route acceptance','After a separately approved deployment, verify current route Accepted/ResolvedRefs and Gateway Programmed conditions. API discovery and dry-run do not establish traffic readiness.');
 return finish();
 function finish(){return {schemaVersion:1,source:options.source||'',mode,generatedAt:new Date().toISOString(),status:blockers.length?'Blocked draft':'Draft — validation unverified',manifests,changes,blockers,prerequisites,tests,untranslatedAnnotations:untranslated,productionReady:false};}
}
function hostSubset(route,listener){if(route===listener)return true;if(!listener.startsWith('*.'))return false;const suffix=listener.slice(1);if(route.startsWith('*.'))return route.slice(1).endsWith(suffix);return route.endsWith(suffix)&&route.length>suffix.length;}
root.MigrationRouting={candidates,generate,selectorMatches,hostSubset};if(typeof module!=='undefined')module.exports=root.MigrationRouting;
})(typeof window!=='undefined'?window:globalThis);
