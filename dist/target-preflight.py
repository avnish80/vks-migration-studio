#!/usr/bin/env python3
"""Read-only target checks plus server-side dry-run. Requires explicit kubectl context.
No context switch, Pod creation, registry pull, deployment, sync, delete or data transfer.
Named Secret/ConfigMap checks request objects locally using name-only CLI output;
values and raw kubectl diagnostics are never written into the result report.
"""
import argparse,datetime,json,os,re,subprocess,sys
KINDS={'Deployment':'deployments.apps','Service':'services','Ingress':'ingresses.networking.k8s.io','HTTPRoute':'httproutes.gateway.networking.k8s.io','ServiceAccount':'serviceaccounts','Secret':'secrets','ConfigMap':'configmaps','IngressClass':'ingressclasses.networking.k8s.io'}
def text(value):
    if not isinstance(value,str) or not value or len(value)>253 or not re.fullmatch(r'[a-z0-9]([-a-z0-9.]*[a-z0-9])?',value):raise ValueError('Invalid resource name/namespace in plan')
    return value

def command(context,args,body=None):
    result=subprocess.run(['kubectl','--context='+context,'--request-timeout=30s']+args,input=body,capture_output=True,text=True,timeout=60)
    if result.returncode:raise RuntimeError('kubectl request failed; inspect authorization, API availability, admission and local diagnostics separately. No raw output is included.')
    return result.stdout

def get(context,resource,name,namespace='',output='name'):
    args=['get',resource,text(name),'--ignore-not-found=true','-o',output]
    if namespace:args+=['--namespace',text(namespace)]
    return command(context,args)

def run(plan,context):
    if plan.get('schemaVersion')!=1 or not isinstance(plan.get('planRevision'),str) or not plan['planRevision'] or not isinstance(plan.get('checks'),list) or len(plan['checks'])>10000:raise ValueError('Invalid preflight plan')
    if not context or len(context)>300 or '\n' in context or '\r' in context:raise ValueError('Explicit context required')
    if plan.get('expectedContext') and plan['expectedContext']!=context:raise ValueError('Context differs from the expected plan context')
    manifests=plan.get('manifests',{})
    if not isinstance(manifests.get('items'),list) or any(r.get('kind') not in ['Deployment','Service','Ingress','HTTPRoute'] for r in manifests['items']):raise ValueError('Unsupported manifest scope')
    checks=plan['checks']
    if not checks or checks[0].get('type')!='identity' or checks[-1].get('type')!='dryrun' or sum(c.get('type')=='identity' for c in checks)!=1 or sum(c.get('type')=='dryrun' for c in checks)!=1:raise ValueError('Identity must be first and the single dry-run must be last')
    results=[];identity_failed=False;prior_failed=False;seen=set()
    for check in plan['checks']:
        key=check.get('id');kind=check.get('type');item={'id':key,'observedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'status':'Unknown','detail':'Not evaluated'}
        if not isinstance(key,str) or key in seen:raise ValueError('Invalid or duplicate check ID')
        seen.add(key)
        try:
            if kind=='identity':
                raw=get(context,'namespaces','kube-system',output='json');obj=json.loads(raw) if raw.strip() else {};uid=obj.get('metadata',{}).get('uid');expected=plan.get('expectedClusterUID');source=plan.get('sourceClusterUID')
                if not uid:item.update(status='Unknown',detail='kube-system UID not observed')
                elif source and uid==source:item.update(status='Fail',detail='Selected context identifies the source cluster; use a distinct target')
                elif expected and uid!=expected:item.update(status='Fail',detail='Observed target identity differs from imported target inventory')
                elif expected:item.update(status='Pass',detail='kube-system UID matches the imported target inventory')
                else:item.update(status='Unknown',detail='Cluster identity observed, but no expected target UID was supplied for binding')
                identity_failed=item['status'] in ['Fail','Error']
            elif kind=='apis':
                available=set(command(context,['api-versions']).split());missing=[x for x in check.get('required',[]) if x not in available];item.update(status='Fail' if missing else 'Pass',detail='Missing API group/versions: '+', '.join(missing) if missing else 'Required group/versions advertised; kind/schema checks still depend on dry-run')
            elif kind=='nodes':
                nodes=json.loads(command(context,['get','nodes','-o','json'])).get('items',[]);ready=[n for n in nodes if any(c.get('type')=='Ready' and c.get('status')=='True' for c in n.get('status',{}).get('conditions',[]))];uncordoned=[n for n in ready if not n.get('spec',{}).get('unschedulable',False)];ok=bool(nodes) and len(ready)==len(nodes) and bool(uncordoned);item.update(status='Pass' if ok else 'Fail',detail='%d nodes, %d Ready, %d Ready/uncordoned. Placement, pressure, taints and free capacity are not evaluated.'%(len(nodes),len(ready),len(uncordoned)))
            elif kind=='namespace':
                raw=get(context,'namespaces',check['namespace'],output='json');obj=json.loads(raw) if raw.strip() else None;phase=obj.get('status',{}).get('phase') if obj else None;item.update(status='Fail' if not obj or phase=='Terminating' or obj.get('metadata',{}).get('deletionTimestamp') else 'Pass' if phase=='Active' else 'Unknown',detail='Namespace absent' if not obj else 'Namespace deletion in progress' if obj.get('metadata',{}).get('deletionTimestamp') else 'Namespace phase: '+str(phase or 'Not reported'))
            elif kind in ['reference','available']:
                resource=KINDS.get(check.get('kind'))
                if not resource:raise ValueError('Unsupported reference kind')
                exists=bool(get(context,resource,check['name'],check.get('namespace','')).strip());ok=exists if kind=='reference' else not exists;item.update(status='Pass' if ok else 'Fail',detail=('Named reference observed; values/keys/access behavior not checked' if exists else 'Named reference absent') if kind=='reference' else ('Conflicting same-named object observed; no merge/ownership change performed' if exists else 'No same-named object observed'))
            elif kind=='gateway':
                raw=get(context,'gateways.gateway.networking.k8s.io',check['name'],check['namespace'],output='json');obj=json.loads(raw) if raw.strip() else None
                if not obj:item.update(status='Fail',detail='Gateway absent')
                else:
                    listener=next((x for x in obj.get('spec',{}).get('listeners',[]) if x.get('name')==check.get('listener')),None);generation=obj.get('metadata',{}).get('generation');condition=next((x for x in obj.get('status',{}).get('conditions',[]) if x.get('type')=='Programmed'),{})
                    ok=listener is not None and generation is not None and condition.get('observedGeneration')==generation and condition.get('status')=='True';item.update(status='Pass' if ok else 'Fail' if listener is None or condition.get('status')=='False' and condition.get('observedGeneration')==generation else 'Unknown',detail='Listener observed with current Gateway Programmed=True; route acceptance and traffic remain untested' if ok else 'Listener or current Programmed=True not confirmed')
            elif kind=='dryrun':
                if plan.get('blockers') or identity_failed or prior_failed or not manifests['items']:item.update(status='Skipped',detail='Known blockers, failed/unknown prerequisites, identity mismatch or empty manifests prevent dry-run')
                else:command(context,['apply','--dry-run=server','--validate=true','-f','-','-o','name'],json.dumps(manifests));item.update(status='Pass',detail='Server-side dry-run succeeded; no resources persisted and no Pods/images/traffic tested')
            else:raise ValueError('Unsupported check type')
        except (ValueError,TypeError,KeyError,RuntimeError,OSError,subprocess.TimeoutExpired) as error:
            item.update(status='Error',detail=str(error));identity_failed=identity_failed or kind=='identity'
        if item['status']!='Pass':prior_failed=True
        results.append(item)
    return {'schemaVersion':1,'planRevision':plan['planRevision'],'context':context,'results':results,'productionReady':False,'limitations':plan.get('limitations',[])}

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--context',required=True);p.add_argument('--plan',default='target-plan.json');p.add_argument('--output',default='target-results.json');a=p.parse_args()
    with open(a.plan,encoding='utf-8') as stream:plan=json.load(stream)
    fd=os.open(a.output,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,'w') as stream:report=run(plan,a.context);json.dump(report,stream,indent=2)
    bad=sum(r['status']!='Pass' for r in report['results']);print('Wrote %d checks; %d unresolved. No persistent cluster changes.'%(len(report['results']),bad));return 1 if bad else 0
if __name__=='__main__':sys.exit(main())
