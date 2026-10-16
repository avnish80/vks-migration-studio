(function(root){
'use strict';
const E=root.MigrationEngine||(typeof require!=='undefined'?require('./engine.js'):null);
const clone=x=>JSON.parse(JSON.stringify(x));
function candidates(raw){return E.normalize(raw).items.filter(r=>r.kind==='Deployment').map(r=>({id:E.id(r),name:r.metadata.name,namespace:r.metadata.namespace||'default'}));}
function generate(raw,options={}){
 const inv=E.normalize(raw),items=inv.items,work=items.find(r=>E.id(r)===options.workload),changes=[],blockers=[],prerequisites=[],omitted=[];
 const block=(reason,resource=options.workload)=>blockers.push({resource,reason});
 const need=(resource,action)=>{if(!prerequisites.some(x=>x.resource===resource&&x.action===action))prerequisites.push({resource,action,status:'Unverified'});};
 const metadata=(r,stripOwnership=true)=>{const m=clone(r.metadata),drop=['uid','resourceVersion','generation','creationTimestamp','deletionTimestamp','deletionGracePeriodSeconds','selfLink','ownerReferences','finalizers','managedFields','generateName'];for(const key of drop)if(key in m){delete m[key];changes.push({resource:E.id(r),path:'metadata.'+key,before:'Source lifecycle field',after:'Removed from draft'});}for(const key of Object.keys(m.labels||{}).filter(E.ownershipLabel))if(stripOwnership){delete m.labels[key];changes.push({resource:E.id(r),path:'metadata.labels.'+key,before:'Source ownership label',after:'Removed; transfer reconciliation in Git'});}for(const key of Object.keys(m.annotations||{}))if(/^(meta.helm.sh\/|argocd.argoproj.io\/tracking-id)/.test(key)){delete m.annotations[key];changes.push({resource:E.id(r),path:'metadata.annotations.'+key,before:'Source ownership annotation',after:'Removed; transfer reconciliation in Git'});}return m;};
 const manifests={apiVersion:'v1',kind:'List',items:[]};
 if(!work||work.kind!=='Deployment'){block('Choose an existing Deployment. StatefulSets, Jobs, DaemonSets and arbitrary custom resources are outside this pilot scope.');return finish();}
 const ns=work.metadata.namespace||'default',pod=E.pod(work),target=options.target?E.normalize(options.target):null;
 if(work.apiVersion!=='apps/v1')block('Deployment must use apps/v1. Update desired-state API first.');
 if(!pod?.containers?.length)block('Pod template has no containers.');
 if(!work.spec?.selector||(!work.spec.selector.matchLabels&&!work.spec.selector.matchExpressions))block('Deployment selector missing; recover the complete desired-state manifest.');
 if(work.metadata.ownerReferences?.length)block('An operator/controller owns this Deployment. Migrate its desired-state resource and lifecycle instead.');
 if(work.spec?.paused)block('Source Deployment is paused; resolve rollout intent before pilot validation.');
 const d={apiVersion:work.apiVersion,kind:'Deployment',metadata:metadata(work),spec:clone(work.spec||{})};
 d.metadata.namespace=ns;
 if(d.spec.template?.metadata){d.spec.template.metadata=metadata({kind:'PodTemplate',metadata:d.spec.template.metadata},false);}
 const dp=E.pod(d)||{};
 for(const v of pod?.volumes||[]){if(!['emptyDir','secret','configMap','projected','downwardAPI'].some(k=>k in v))block(`Volume ${v.name} requires a storage-specific migration path.`);if(v.secret)need(`${ns}/Secret/${v.secret.secretName}`,'Provision the referenced secret and keys through the approved target provider.');if(v.configMap)need(`${ns}/ConfigMap/${v.configMap.name}`,'Restore full configuration from desired state; values are omitted from this inventory.');for(const s of v.projected?.sources||[]){if(s.secret)need(`${ns}/Secret/${s.secret.name}`,'Provision projected secret and keys.');if(s.configMap)need(`${ns}/ConfigMap/${s.configMap.name}`,'Provision projected configuration and keys.');}}
 if(pod?.hostNetwork||pod?.hostPID||pod?.hostIPC)block('Host network/process namespace sharing needs a separate platform and security review.');
 const annotations={...work.metadata.annotations,...work.spec?.template?.metadata?.annotations};
 if(annotations['k8s.v1.cni.cncf.io/networks'])block('Multus/NAD attachments cannot be translated by the stateless generator.');
 for(const key of Object.keys(annotations))if(/eks.amazonaws.com|iam.gke.io|azure.workload|sidecar.istio.io|linkerd.io/.test(key))block(`Provider or mesh annotation requires explicit migration: ${key}.`);
 const all=[...dp.containers||[],...dp.initContainers||[],...dp.ephemeralContainers||[]];
 for(const c of all){
  if(c.securityContext?.privileged)block(`Container ${c.name} requests privileged mode.`);
  if(c.resources?.limits?.['nvidia.com/gpu']||c.resources?.requests?.['nvidia.com/gpu'])block(`Container ${c.name} requires GPU platform validation.`);
  if(c.ports?.some(p=>p.hostPort))block(`Container ${c.name} reserves node host ports.`);
  if(c.volumeDevices?.length)block(`Container ${c.name} uses block device storage.`);
  for(const e of c.env||[]){if(!e.valueFrom&&!Object.hasOwn(e,'value'))block(`Environment ${c.name}/${e.name} has an omitted inline value. Recover it from the desired-state repository; this draft is incomplete.`);const ref=e.valueFrom?.secretKeyRef||e.valueFrom?.configMapKeyRef;if(ref)need(`${ns}/${e.valueFrom.secretKeyRef?'Secret':'ConfigMap'}/${ref.name}`,'Provision referenced keys before testing. Values are never exported.');}
  for(const e of c.envFrom||[]){const ref=e.secretRef||e.configMapRef;if(ref)need(`${ns}/${e.secretRef?'Secret':'ConfigMap'}/${ref.name}`,'Provision full referenced configuration before testing.');}
  const mapped=options.images?.[c.image];if(mapped&&mapped!==c.image){if(/\s|:\/\//.test(mapped)||!mapped.trim())block(`Invalid destination image reference for ${c.name}.`);else{changes.push({resource:E.id(work),path:`containers[${c.name}].image`,before:c.image,after:mapped});c.image=mapped;}}
  need('image:'+c.image,'Verify digest, architecture, registry access, signatures and target image pull. No image copying has occurred.');
 }
 for(const p of pod?.imagePullSecrets||[])need(`${ns}/Secret/${p.name}`,'Provision registry authentication on the target; do not export source secret payloads.');
 const sourceSA=pod?.serviceAccountName||pod?.serviceAccount||'default',mappedSA=options.serviceAccount?.trim()||sourceSA;
 if(!/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/.test(mappedSA)||mappedSA.length>253)block('Destination service account name is invalid.');
 if(mappedSA!==sourceSA){dp.serviceAccountName=mappedSA;delete dp.serviceAccount;changes.push({resource:E.id(work),path:'spec.template.spec.serviceAccountName',before:sourceSA,after:mappedSA});}
 const sa=items.find(r=>r.kind==='ServiceAccount'&&(r.metadata.namespace||'default')===ns&&r.metadata.name===sourceSA);
 const cloudSA=Object.keys(sa?.metadata?.annotations||{}).some(k=>/eks.amazonaws.com|iam.gke.io|azure.workload/.test(k));
 if(cloudSA&&mappedSA===sourceSA)block('Cloud workload identity detected. Explicitly map a reviewed target service account and permissions.');
 need(`${ns}/ServiceAccount/${mappedSA}`,'Verify service account, token audiences and least-privilege permissions, including access to external services.');
 if(cloudSA&&mappedSA!==sourceSA&&!target?.items.some(r=>r.kind==='ServiceAccount'&&(r.metadata.namespace||'default')===ns&&r.metadata.name===mappedSA))block('Remapped cloud identity service account is not observed in the target inventory.');
 const sourceNS=items.find(r=>r.kind==='Namespace'&&r.metadata.name===ns);
 need('Namespace/'+ns,'Prepare destination namespace with equivalent admission labels, quotas, limits and effective isolation. Source labels: '+JSON.stringify(sourceNS?.metadata.labels||{}));
 need('Security parity','Validate admission, NetworkPolicy, RBAC, mesh and secret access with both allowed and denied test cases. Policy resources are prerequisites, not included in this workload draft.');
 need('Desired-state ownership','Review Helm/Argo/Flux ownership and promote changes through the owning repository; prevent competing reconciliation.');
 need('Application state and recovery','Owner must confirm external state, dependencies, success criteria and pilot recovery. A Deployment can still depend on a database.');
 if(pod?.nodeSelector||pod?.affinity||pod?.tolerations?.length)need('Scheduling','Verify node labels, zones, architecture, taints and target capacity; source scheduling settings are preserved.');
 manifests.items.push(d);
 const labels=work.spec?.template?.metadata?.labels||{},sameNS=r=>(r.metadata.namespace||'default')===ns;
 const matches=r=>r.spec?.selector&&Object.keys(r.spec.selector).length&&Object.entries(r.spec.selector).every(([k,v])=>labels[k]===v);
 const services=items.filter(r=>r.kind==='Service'&&sameNS(r)&&matches(r));
 for(const r of services){
  if((r.spec.type||'ClusterIP')!=='ClusterIP'){omitted.push(E.id(r));block('Matching Service is not ClusterIP; load-balancer and NodePort translation require a separate mapping.',E.id(r));continue;}
  const peers=items.filter(x=>['Deployment','StatefulSet','DaemonSet','Pod','ReplicaSet','Job','CronJob'].includes(x.kind)&&sameNS(x)&&E.id(x)!==E.id(work)&&Object.entries(r.spec.selector).every(([k,v])=>(x.spec?.template?.metadata?.labels||x.spec?.jobTemplate?.spec?.template?.metadata?.labels||x.metadata.labels||{})[k]===v));
  if(peers.length){omitted.push(E.id(r));block('Service selector matches additional source resources. Review shared routing before exporting the Service.',E.id(r));continue;}
  const service={apiVersion:'v1',kind:'Service',metadata:metadata(r),spec:clone(r.spec)};service.metadata.namespace=ns;
  for(const key of ['clusterIP','clusterIPs','ipFamilies','ipFamilyPolicy','healthCheckNodePort'])if(key in service.spec&&!(key==='clusterIP'&&service.spec[key]==='None')){delete service.spec[key];changes.push({resource:E.id(r),path:'spec.'+key,before:'Source-assigned networking',after:'Destination allocation/default'});}
  if(r.spec.externalIPs?.length||r.spec.loadBalancerIP||r.spec.loadBalancerClass)block('Service has infrastructure-bound addresses or controller configuration; review manually.',E.id(r));
  for(const port of service.spec.ports||[])if(port.nodePort){delete port.nodePort;block('ClusterIP Service contains a nodePort assignment; review desired-state schema.',E.id(r));}
  for(const key of Object.keys(r.metadata.annotations||{}))if(/aws|azure|gke|load.?balancer|external-dns/i.test(key))block(`Service annotation needs target-specific review: ${key}.`,E.id(r));
  manifests.items.push(service);
 }
 for(const r of items.filter(sameNS))if(['Ingress','HTTPRoute','Gateway','HorizontalPodAutoscaler','PodDisruptionBudget','NetworkPolicy'].includes(r.kind)){omitted.push(E.id(r));need(E.id(r),'Review and provision separately. This generator exports only the selected Deployment and isolated ClusterIP Services; routing, policy, disruption and scaling behavior remain unverified.');}
 if(!services.length)need('Service discovery','No matching Service observed. Confirm whether one is required.');
 if(target){for(const r of manifests.items)if(target.items.some(t=>E.id(t)===E.id(r)))block('Same-named destination object exists. Resolve ownership and merge intent before pilot validation.',E.id(r));for(const c of targetConsumers(target,ns,d.metadata.name,manifests.items.filter(r=>r.kind==='Service').map(r=>r.metadata.name)))block(c.reason,c.resource);const apis=target.collection?.apiVersions;if(target.collection?.apiDiscoveryComplete===true)for(const api of new Set(manifests.items.map(r=>r.apiVersion)))if(!apis?.includes(api))block('Destination API discovery does not advertise '+api);}
 else need('Target inventory','Import destination evidence and review names, API availability, controllers and prerequisites.');
 return finish();
 function finish(){return {schemaVersion:1,generatedAt:new Date().toISOString(),workload:options.workload||'',status:blockers.length?'Blocked draft':'Draft — prerequisites unverified',productionReady:false,manifests,changes,blockers,prerequisites,omitted:[...new Set(omitted)],notes:'No cluster changes, image copies, credential transfers or tests have occurred. Sanitized inventory cannot replace the complete desired-state repository.'};}
}
function targetConsumers(target,ns,deployment,services){
 // Existing target objects that would send traffic to, or scale, the pilot as soon as it is created.
 const out=[],inNS=r=>(r.metadata?.namespace||'default')===ns,svc=new Set(services),list=v=>Array.isArray(v)?v:[];
 for(const r of target.items.filter(inNS)){
  const id=E.id(r),spec=r.spec||{};
  if(r.kind==='Ingress'){const refs=[spec.defaultBackend?.service?.name,...list(spec.rules).flatMap(x=>list(x.http?.paths).map(p=>p.backend?.service?.name))];for(const n of new Set(refs.filter(n=>svc.has(n))))out.push({resource:id,reason:`Existing target Ingress routes to Service ${n}; the pilot Service would receive traffic as soon as it is created. Remove or repoint the route first.`});}
  if(['HTTPRoute','GRPCRoute','TLSRoute','TCPRoute','UDPRoute'].includes(r.kind)){const refs=list(spec.rules).flatMap(x=>list(x.backendRefs)).filter(b=>(b.kind||'Service')==='Service'&&!b.group&&(b.namespace||ns)===ns).map(b=>b.name);for(const n of new Set(refs.filter(n=>svc.has(n))))out.push({resource:id,reason:`Existing target ${r.kind} routes to Service ${n}; the pilot Service would receive traffic as soon as it is created. Remove or repoint the route first.`});}
  if(r.kind==='ReferenceGrant'&&list(spec.to).some(t=>!t.group&&t.kind==='Service'&&(!t.name||svc.has(t.name))))out.push({resource:id,reason:'ReferenceGrant allows routes in other namespaces to reach pilot Services. Review cross-namespace routes first.'});
  const ref=r.kind==='HorizontalPodAutoscaler'||r.kind==='ScaledObject'?spec.scaleTargetRef:r.kind==='VerticalPodAutoscaler'?spec.targetRef:null;
  if(ref&&(ref.kind||'Deployment')==='Deployment'&&ref.name===deployment)out.push({resource:id,reason:`Existing target ${r.kind} targets Deployment ${deployment}; it would change the one-replica pilot. Remove it before the pilot.`});
 }
 return out;
}
function validationScript(bundle){return '#!/usr/bin/env bash\nset -euo pipefail\n# Review pilot-review.json and provision every prerequisite first.\n# This script never applies persistent changes or switches your current context.\n'+(bundle.blockers.length?"printf '%s\\n' 'STOP: draft has blockers. Resolve them and regenerate.' >&2\nexit 2\n":'if [ "$#" -ne 1 ]; then printf \'%s\\n\' \'Usage: bash validate-pilot.sh TARGET_CONTEXT\' >&2; exit 2; fi\nctx="$1"\nkubectl --context "$ctx" apply --dry-run=server -f pilot-draft.json\nset +e\nkubectl --context "$ctx" diff -f pilot-draft.json\nrc=$?\nset -e\nif [ "$rc" -gt 1 ]; then exit "$rc"; fi\nprintf \'%s\\n\' \'Dry-run/diff completed. Diff exit 1 means differences. No deployment performed. Application and security tests still required.\'\n');}
root.MigrationPilot={candidates,generate,validationScript,targetConsumers};if(typeof module!=='undefined')module.exports=root.MigrationPilot;
})(typeof window!=='undefined'?window:globalThis);
