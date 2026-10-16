(function(root){
'use strict';
const E=root.MigrationEngine||(typeof require!=='undefined'?require('./engine.js'):null);
const OUTCOMES=['Allowed','PolicyDenied','WarningObserved','AuditObserved','ReviewConfirmed'];
function classify(r){const api=r.apiVersion||'',kind=r.kind;
 if(kind==='Namespace'&&Object.keys(r.metadata.labels||{}).some(k=>k.startsWith('pod-security.kubernetes.io/')))return {family:'Pod Security Admission',enforcement:r.metadata.labels['pod-security.kubernetes.io/enforce']?'Enforce':r.metadata.labels['pod-security.kubernetes.io/warn']?'Warn':'Audit',expected:r.metadata.labels['pod-security.kubernetes.io/enforce']?'PolicyDenied':r.metadata.labels['pod-security.kubernetes.io/warn']?'WarningObserved':'AuditObserved'};
 if(kind==='NetworkPolicy'&&api==='networking.k8s.io/v1')return {family:'Kubernetes NetworkPolicy',enforcement:'CNI-dependent',expected:'PolicyDenied'};
 if(/^(constraints|templates|config|mutations|externaldata|syncset|expansion)\.gatekeeper\.sh\//.test(api)){const constraint=api.startsWith('constraints.gatekeeper.sh/'),action=constraint?r.spec?.enforcementAction||'deny':'Dependency';return {family:'OPA Gatekeeper',enforcement:action,expected:constraint?({deny:'PolicyDenied',warn:'WarningObserved',dryrun:'AuditObserved'}[action]||'Define'):'ReviewConfirmed'};}
 if(/kyverno\.io\//.test(api)&&['Policy','ClusterPolicy','ValidatingPolicy','MutatingPolicy','GeneratingPolicy','DeletingPolicy'].includes(kind))return {family:'Kyverno',enforcement:r.spec?.validationFailureAction||'Inspect per-rule action',expected:'Define'};
 if(['NetworkPolicy','ClusterNetworkPolicy','GlobalNetworkPolicy','AntreaClusterNetworkPolicy','AntreaNetworkPolicy','CiliumNetworkPolicy','CiliumClusterwideNetworkPolicy','AdminNetworkPolicy','BaselineAdminNetworkPolicy'].includes(kind))return {family:'Vendor / extended network policy',enforcement:'Implementation-specific',expected:'PolicyDenied'};
 if(['RoleBinding','ClusterRoleBinding'].includes(kind))return {family:'RBAC binding',enforcement:'Effective role + subject permissions',expected:'PolicyDenied'};
 if(['Role','ClusterRole','ConstraintTemplate','CustomResourceDefinition'].includes(kind))return kind==='CustomResourceDefinition'?null:{family:'Policy dependency',enforcement:'Definition; inspect consumers',expected:'ReviewConfirmed'};
 if(kind==='ServiceAccount'&&Object.keys(r.metadata.annotations||{}).some(k=>/eks.amazonaws.com|iam.gke.io|azure.workload/.test(k)))return {family:'Workload identity',enforcement:'Provider-specific',expected:'PolicyDenied'};
 if(['ExternalSecret','SecretStore','ClusterSecretStore','SealedSecret'].includes(kind))return {family:'Secret integration',enforcement:'Provider/identity dependent',expected:'PolicyDenied'};
 if(['AuthorizationPolicy','PeerAuthentication'].includes(kind))return {family:'Service mesh security',enforcement:'Mesh-dependent',expected:'PolicyDenied'};
 if(['ValidatingAdmissionPolicy','ValidatingAdmissionPolicyBinding','ValidatingWebhookConfiguration','MutatingWebhookConfiguration'].includes(kind))return {family:'Admission policy / webhook',enforcement:'Inspect bindings, exclusions and failure policy',expected:'Define'};
 if(kind==='NetworkAttachmentDefinition')return {family:'Secondary network isolation',enforcement:'Topology/CNI-specific',expected:'PolicyDenied'};
 return null;
}
function catalog(raw){return E.normalize(raw).items.flatMap(r=>{const type=classify(r);return type?[{id:E.id(r),apiVersion:r.apiVersion,kind:r.kind,namespace:r.metadata.namespace||null,...type,source:r}]:[];});}
function plan(raw,target,decisions={},revision){
 if(typeof revision!=='string'||!revision)throw Error('Security plan requires a session revision.');
 const destination=target?E.normalize(target):null,controls=catalog(raw).map(c=>{
  const d=decisions[c.id]||{},targetResource=destination?.items.find(r=>E.id(r)===d.targetRef),expected=c.expected==='Define'?(d.violationExpected||'Define'):c.expected;
  const mapping=['Retain','Replace','Manual adaptation'].includes(d.action)&&!!targetResource&&!!d.rationale?.trim();
  const scenarios=!!d.allowScenario?.trim()&&!!d.violationScenario?.trim()&&OUTCOMES.includes(expected);
  return {...c,action:d.action||'Unmapped',targetRef:d.targetRef||'',targetObserved:!!targetResource,rationale:d.rationale||'',mappingComplete:mapping,scenariosDefined:scenarios,tests:[{id:'positive',scenario:d.allowScenario||'',expected:c.expected==='ReviewConfirmed'?'ReviewConfirmed':'Allowed'},{id:'violation',scenario:d.violationScenario||'',expected}],source:undefined};
 });
 return {schemaVersion:1,planRevision:revision,controls,targetImported:!!destination,coverage:{status:'Incomplete / owner review required',source:E.normalize(raw).collection,target:destination?.collection||null},gate:'Closed',productionReady:false,notes:'Every control is required. Object presence, manual mapping and reported test outcomes do not independently establish effective security. Unknown controls, exemptions, runtime policy order and platform dependencies still require owner review.'};
}
function template(plan){return {schemaVersion:1,planRevision:plan.planRevision,results:plan.controls.flatMap(c=>c.tests.flatMap(t=>['source','target'].map(side=>({controlId:c.id,caseId:t.id,side,context:'',observedAt:'',outcome:'NotRun',evidenceRef:'',detail:''})))),instructions:'Fill results after actual scoped tests. Context must be explicit; use distinct source/target contexts. outcome: Allowed, PolicyDenied, WarningObserved, AuditObserved, ReviewConfirmed, or Error. A timeout, authentication error or missing backend is Error, not PolicyDenied. References must identify reviewable logs/test artifacts; do not include credentials or secret values.'};}
function importEvidence(plan,input){
 if(input?.schemaVersion!==1||input.planRevision!==plan.planRevision||!Array.isArray(input.results)||input.results.length>120000)throw Error('Results must match the current security plan revision and contain a results array.');
 const seen=new Set(),results=[];
 for(const r of input.results){const c=plan.controls.find(c=>c.id===r.controlId),t=c?.tests.find(t=>t.id===r.caseId);if(!t||!['source','target'].includes(r.side))throw Error('Unknown control, case or test side.');const key=[r.controlId,r.caseId,r.side].join('|');if(seen.has(key))throw Error('Duplicate security result.');seen.add(key);
  const at=Date.parse(r.observedAt),context=typeof r.context==='string'?r.context.trim():'',ref=typeof r.evidenceRef==='string'?r.evidenceRef.trim():'',detail=typeof r.detail==='string'?r.detail.trim():'';
  const complete=OUTCOMES.includes(r.outcome)&&!!context&&!!ref&&!!detail&&Number.isFinite(at)&&at<=Date.now()+300000;
  results.push({controlId:c.id,caseId:t.id,side:r.side,context:context.slice(0,300),observedAt:Number.isFinite(at)?new Date(at).toISOString():null,outcome:OUTCOMES.includes(r.outcome)?r.outcome:'Error',evidenceRef:ref.slice(0,2000),detail:detail.slice(0,4000),status:complete&&c.scenariosDefined&&r.outcome===t.expected?'Reported match':'Unresolved'});
 }
 return {schemaVersion:1,planRevision:plan.planRevision,importedAt:new Date().toISOString(),results,productionReady:false,note:'Externally supplied evidence is not independently authenticated or rerun by this app. Owner review remains required.'};
}
function summary(plan,evidence){const results=evidence?.planRevision===plan.planRevision?evidence.results:[],controls=plan.controls.map(c=>{
 const records=results.filter(r=>r.controlId===c.id),contexts=side=>[...new Set(records.filter(r=>r.side===side).map(r=>r.context).filter(Boolean))];
 const distinct=contexts('source').length===1&&contexts('target').length===1&&contexts('source')[0]!==contexts('target')[0];
 const complete=c.mappingComplete&&c.scenariosDefined&&distinct&&c.tests.every(t=>['source','target'].every(side=>records.some(r=>r.caseId===t.id&&r.side===side&&r.status==='Reported match')));
 return {id:c.id,status:complete?'Reported cases complete':'Unresolved',mappingComplete:c.mappingComplete,scenariosDefined:c.scenariosDefined,distinctContexts:distinct};
 });return {gate:'Closed',productionReady:false,controls,total:controls.length,reportedComplete:controls.filter(c=>c.status==='Reported cases complete').length,unresolved:controls.filter(c=>c.status==='Unresolved').length,reason:'Security parity requires independent owner review, coverage closure and additional application/platform tests. Reported results cannot open the production gate.'};}
root.MigrationSecurity={catalog,plan,template,importEvidence,summary,OUTCOMES};if(typeof module!=='undefined')module.exports=root.MigrationSecurity;
})(typeof window!=='undefined'?window:globalThis);
