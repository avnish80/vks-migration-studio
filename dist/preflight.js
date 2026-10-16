(function(root){
'use strict';
const E=root.MigrationEngine||(typeof require!=='undefined'?require('./engine.js'):null);
function compare(source,target,mappings={}){
 const src=E.normalize(source), dst=target?E.normalize(target):null, rows=[];
 const add=(area,resource,status,evidence,action)=>rows.push({area,resource,status,evidence,action});
 const targetItems=dst?.items||[], queried=new Set(dst?.collection?.queriedResources||[]), errors=dst?.collection?.errors||[];
 const covered=name=>queried.has(name)&&!errors.some(e=>e.resource===name);
 const apis=new Set(dst?.collection?.apiVersions||[]), byKind=k=>targetItems.filter(r=>r.kind===k);
 const ref=r=>E.id(r);
 for(const api of [...new Set(src.items.map(r=>r.apiVersion).filter(Boolean))]){
  const known=dst?.collection?.apiDiscoveryComplete===true;
  add('API',api,apis.has(api)?'Observed':known?'Blocker':'Unknown',apis.has(api)?'Group/version advertised by destination discovery.':known?'Group/version not advertised by destination discovery.':'Successful destination API discovery not supplied.','Check kind, schemas and admission with target dry-run; presence alone does not establish compatibility.');
 }
 for(const r of src.items.filter(r=>r.kind==='CustomResourceDefinition')){
  const t=byKind(r.kind).find(x=>x.metadata.name===r.metadata.name);
  const versions=(r.spec?.versions||[]).filter(v=>v.served).map(v=>v.name);
  const missing=versions.filter(v=>!t?.spec?.versions?.some(x=>x.name===v&&x.served));
  add('CRD',ref(r),t?(missing.length?'Blocker':'Observed'):covered('customresourcedefinitions')?'Blocker':'Unknown',t?`Target definition found; source served versions missing: ${missing.join(', ')||'none'}.`:'Target definition not observed.','Verify controller ownership, schemas, conversion webhooks and custom resource migration procedures.');
 }
 for(const r of src.items.filter(r=>['PersistentVolumeClaim','Ingress','Gateway'].includes(r.kind))){
  const storage=r.kind==='PersistentVolumeClaim', gateway=r.kind==='Gateway';
  const kind=storage?'StorageClass':gateway?'GatewayClass':'IngressClass', plural=storage?'storageclasses':gateway?'gatewayclasses.gateway.networking.k8s.io':'ingressclasses';
  const sourceName=storage?r.spec?.storageClassName:gateway?r.spec?.gatewayClassName:r.spec?.ingressClassName||r.metadata.annotations?.['kubernetes.io/ingress.class'];
  const key=(storage?'storage:':gateway?'gateway:':'ingress:')+(sourceName??'<default>');
  const chosen=mappings[key]||sourceName;
  const t=chosen?byKind(kind).find(x=>x.metadata.name===chosen):null;
  const explicit=storage&&sourceName==='';
  add(storage?'Storage':'Traffic',ref(r),explicit?'Unknown':t?'Observed':covered(plural)&&chosen?'Blocker':'Unknown',explicit?'PVC requests no dynamic storage class.':t?`${sourceName??'unspecified'} → ${chosen}; target ${kind} observed (${t.provisioner||t.spec?.controller||'controller unspecified'}).`:`${sourceName??'unspecified/default'} → ${chosen||'unmapped'}; target ${kind} not observed.`,storage?'Validate CSI, access mode, topology, encryption, restore and data consistency.':'Validate routes, TLS, rewrites, authentication, WAF, and load-balancer behavior.');
 }
 add('Security','Admission, network isolation and identities','Unknown','No behavioral test results imported. Existing policies or matching CRDs cannot prove equivalent enforcement.','Run allowed/denied admission, connectivity and authorization tests.');
 add('Operations','Data consistency, image pulls and capacity','Unknown','Inventory inspection does not execute tests or observe target performance.','Validate target pulls, representative load, recovery, application acceptance and stateful consistency.');
 return {generatedAt:new Date().toISOString(),sourceVersion:src.sourceVersion,targetVersion:dst?.sourceVersion||'Not supplied',targetImported:!!dst,mappings:{...mappings},rows,productionReady:false};
}
function buildPlan(report,comparison){
 const phases=[{id:'evidence',title:'Close evidence and target gaps',dependsOn:[],categories:['Discovery','Target','Dependencies','APIs']},{id:'platform',title:'Prepare platform, identity and security',dependsOn:['evidence'],categories:['Platform','Identity','Security','Secrets','Network','Compute']},{id:'artifacts',title:'Prepare images, routing, storage and GitOps',dependsOn:['platform'],categories:['Images','Traffic','Storage','GitOps','Availability']},{id:'pilot',title:'Validate stateless pilot',dependsOn:['artifacts'],categories:[]},{id:'stateful',title:'Migrate stateful applications',dependsOn:['pilot'],categories:[]},{id:'cutover',title:'Validate and cut over traffic',dependsOn:['stateful'],categories:[]}];
 for(const p of phases){p.findings=report.findings.filter(f=>p.categories.includes(f.category)).map(f=>f.id);p.targetGaps=(comparison?.rows||[]).filter(r=>r.status!=='Observed'&&(p.id==='evidence'?['API','CRD'].includes(r.area):p.id==='platform'?r.area==='Security':p.id==='artifacts'?['Storage','Traffic'].includes(r.area):p.id==='cutover'?r.area==='Operations':false));p.workloads=[];}
 for(const wid of report.workloads){const r=report.resources.find(x=>E.id(x)===wid),spec=E.pod(r);const stateful=r.kind==='StatefulSet'||spec?.volumes?.some(v=>v.persistentVolumeClaim||v.hostPath);const deps=report.edges.filter(e=>e.from===wid);phases.find(p=>p.id===(stateful?'stateful':'pilot')).workloads.push({resource:wid,classification:stateful?'Declared persistent/node-local state':'No declared volume state; owner confirmation required',dependencies:deps.map(e=>e.to),blockers:report.findings.filter(f=>f.resource===wid&&f.severity==='Blocker').map(f=>f.id)});}
 return {phases,productionReady:false,notes:'Suggested sequencing only. External state, cross-application dependencies, controller readiness and cycles require owner review. No automatic execution or verified completion.'};
}
root.MigrationPreflight={compare,buildPlan};if(typeof module!=='undefined')module.exports=root.MigrationPreflight;
})(typeof window!=='undefined'?window:globalThis);
