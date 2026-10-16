#!/usr/bin/env python3
"""Read-only kubectl collector. No cluster writes. Inspect the inventory before sharing."""
import argparse, json, re, subprocess, datetime, os
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--context',required=True,help='Explicit kubectl context to read')
p.add_argument('--output',default='inventory.json')
a=p.parse_args()
base=['kubectl','--context',a.context,'--request-timeout=30s']
errors=[];items=[];queried=[];api_versions=[];api_discovery=False
def reason(stderr):
    # kubectl stderr can name the user, API server and exec-plugin output; export a category only.
    for label,pattern in [('Forbidden','forbidden'),('Unauthorized','unauthorized|must be logged in|credentials'),('NotFound','not found|doesn.t have a resource type'),('Timeout','timeout|timed out|deadline'),('Unreachable','connection refused|no such host|unable to connect')]:
        if re.search(pattern,stderr or '',re.I):return label
    return 'Other'
def query(args):
    try:result=subprocess.run(base+args,capture_output=True,text=True,timeout=120)
    except subprocess.TimeoutExpired:raise RuntimeError('Timeout')
    if result.returncode: raise RuntimeError(reason(result.stderr))
    return json.loads(result.stdout)
# Fields of GitOps objects that commonly carry plaintext credentials.
def redact(item):
    spec=item.get('spec') if isinstance(item.get('spec'),dict) else {}
    kind=item.get('kind')
    if kind=='HelmRelease':spec.pop('values',None)
    if kind=='Kustomization' and isinstance(spec.get('postBuild'),dict):spec['postBuild'].pop('substitute',None)
    if kind in ['Application','ApplicationSet']:
        specs=[spec]+([spec['template']['spec']] if isinstance(spec.get('template'),dict) and isinstance(spec['template'].get('spec'),dict) else [])
        for s in specs:
            for source in [s.get('source')]+(s.get('sources') if isinstance(s.get('sources'),list) else []):
                if not isinstance(source,dict):continue
                for key,fields in [('helm',['values','valuesObject','parameters','fileParameters']),('plugin',['env','parameters'])]:
                    if isinstance(source.get(key),dict):
                        for f in fields:source[key].pop(f,None)
    return item
def clean(v):
    if isinstance(v,list):return [clean(x) for x in v]
    if isinstance(v,dict):return {k:clean(x) for k,x in v.items() if k not in ['data','stringData','binaryData','value','status','managedFields','kubectl.kubernetes.io/last-applied-configuration']}
    return v
try:version=query(['version','-o','json']).get('serverVersion',{}).get('gitVersion','unknown')
except Exception as e:version='unknown';errors.append({'resource':'version','reason':str(e)})
# List API types without reading Secret payloads or arbitrary CRs. Unknown custom kinds
# are represented by CRD definitions and require separate local inspection.
resources=['namespaces','nodes','deployments','statefulsets','daemonsets','jobs','cronjobs','services','ingresses','ingressclasses','persistentvolumeclaims','persistentvolumes','storageclasses','serviceaccounts','roles','rolebindings','clusterroles','clusterrolebindings','networkpolicies','poddisruptionbudgets','horizontalpodautoscalers','customresourcedefinitions','validatingwebhookconfigurations','mutatingwebhookconfigurations','validatingadmissionpolicies','validatingadmissionpolicybindings']
for name in resources:
    try:
        items.extend(redact(x) for x in clean(query(['get',name,'--all-namespaces','-o','json']).get('items',[])));queried.append(name)
    except Exception as e:errors.append({'resource':name,'reason':str(e)})
# Known controller/policy types. API absence is recorded as coverage information.
optional=['csidrivers.storage.k8s.io','volumesnapshotclasses.snapshot.storage.k8s.io','configs.config.gatekeeper.sh','syncsets.syncset.gatekeeper.sh','providers.externaldata.gatekeeper.sh','assign.mutations.gatekeeper.sh','assignmetadata.mutations.gatekeeper.sh','assignimage.mutations.gatekeeper.sh','modifyset.mutations.gatekeeper.sh','adminnetworkpolicies.policy.networking.k8s.io','baselineadminnetworkpolicies.policy.networking.k8s.io','validatingpolicies.policies.kyverno.io','mutatingpolicies.policies.kyverno.io','network-attachment-definitions.k8s.cni.cncf.io','constrainttemplates.templates.gatekeeper.sh','clusterpolicies.kyverno.io','policies.kyverno.io','applications.argoproj.io','applicationsets.argoproj.io','helmreleases.helm.toolkit.fluxcd.io','kustomizations.kustomize.toolkit.fluxcd.io','externalsecrets.external-secrets.io','secretstores.external-secrets.io','clustersecretstores.external-secrets.io','gateways.gateway.networking.k8s.io','gatewayclasses.gateway.networking.k8s.io','httproutes.gateway.networking.k8s.io','grpcroutes.gateway.networking.k8s.io','tlsroutes.gateway.networking.k8s.io','tcproutes.gateway.networking.k8s.io','udproutes.gateway.networking.k8s.io','referencegrants.gateway.networking.k8s.io','httpproxies.projectcontour.io','scaledobjects.keda.sh','verticalpodautoscalers.autoscaling.k8s.io','clusternetworkpolicies.crd.antrea.io','networkpolicies.crd.antrea.io','globalnetworkpolicies.crd.projectcalico.org','networkpolicies.crd.projectcalico.org','ciliumnetworkpolicies.cilium.io','ciliumclusterwidenetworkpolicies.cilium.io','authorizationpolicies.security.istio.io','peerauthentications.security.istio.io']
try:
    available=set(subprocess.run(base+['api-resources','-o','name'],capture_output=True,text=True,check=True,timeout=120).stdout.split())
    for crd in items:
        if crd['kind']=='CustomResourceDefinition' and crd.get('spec',{}).get('group')=='constraints.gatekeeper.sh':optional.append(crd['metadata']['name'])
    for name in optional:
        if name in available:
            try:
                items.extend(redact(x) for x in clean(query(['get',name,'--all-namespaces','-o','json']).get('items',[])));queried.append(name)
            except Exception as e:errors.append({'resource':name,'reason':str(e)})
except Exception as e:errors.append({'resource':'api-resources','reason':str(e)})
try:
    api_versions=subprocess.run(base+['api-versions'],capture_output=True,text=True,check=True,timeout=120).stdout.split();api_discovery=True
except Exception as e:errors.append({'resource':'api-versions','reason':str(e)})
result={'kind':'List','apiVersion':'v1','sourceVersion':version,'collection':{'complete':False,'collectorVersion':'0.4.0','queriedResources':queried,'apiVersions':api_versions,'apiDiscoveryComplete':api_discovery,'collectedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'errors':errors,'limitations':['Secrets and ConfigMaps are not queried. Inline env values, data, status and managedFields are omitted.','Not all custom resources are collected. Confirm unknown operators locally.','Annotations, pod commands/args and arbitrary custom fields may contain sensitive data. Inspect before import.','Runtime dependencies, target compatibility and enforcement are not tested.']},'items':items}
fd=os.open(a.output,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
with os.fdopen(fd,'w') as f:json.dump(result,f,indent=2)
print(f'Wrote {len(items)} resources to {a.output}; {len(errors)} query failures. Review file before import.')
