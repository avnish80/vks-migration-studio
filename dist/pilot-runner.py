#!/usr/bin/env python3
"""Explicit-context, create-only one-replica pilot. Recovery cleanup is a separate confirmed operation. No source mutation or automatic rollback."""
import argparse,copy,datetime,importlib.util,json,os,queue,re,subprocess,sys,threading,time,tempfile,urllib.error,urllib.request,uuid
from pathlib import Path
LABEL='migration-studio.openai/pilot-run'
KINDS={'Deployment':'deployments.apps','Service':'services'}
spec=importlib.util.spec_from_file_location('pilot_preflight',Path(__file__).with_name('target-preflight.py'));preflight=importlib.util.module_from_spec(spec);spec.loader.exec_module(preflight)
def now():return datetime.datetime.now(datetime.timezone.utc).isoformat()
def name(value):return preflight.text(value)
def command(context,args,body=None,timeout=60):
    result=subprocess.run(['kubectl','--context='+context,'--request-timeout=30s']+args,input=body,capture_output=True,text=True,timeout=timeout)
    if result.returncode:raise RuntimeError('kubectl request failed; inspect the intended target locally. Raw diagnostics are omitted.')
    return result.stdout

def validate_plan(p,context):
    if p.get('kind')!='PilotExecutionPlan' or p.get('schemaVersion')!=1 or not isinstance(p.get('binding'),str):raise ValueError('Invalid execution plan')
    bound={k:p[k] for k in ['planRevision','workload','settings','preflight','blockers','prerequisites']}
    if json.loads(p['binding'])!=bound:raise ValueError('Execution plan differs from its binding; regenerate the package')
    t=p['preflight'];s=p['settings']
    if not isinstance(context,str) or not context or len(context)>300 or '\n' in context or '\r' in context or context!=t.get('expectedContext'):raise ValueError('Explicit context must match the execution plan')
    if not t.get('sourceClusterUID') or not t.get('expectedClusterUID') or t['sourceClusterUID']==t['expectedClusterUID']:raise ValueError('Distinct known source and target cluster UIDs required')
    if p['blockers'] or t.get('blockers'):raise ValueError('Resolve all generated plan blockers before running')
    if t.get('planRevision')!=p.get('planRevision'):raise ValueError('Inconsistent plan revision')
    items=t.get('manifests',{}).get('items',[]);deployments=[r for r in items if r.get('kind')=='Deployment']
    if len(deployments)!=1 or not 1<=len(items)<=11:raise ValueError('Exactly one Deployment and at most ten Services required')
    d=deployments[0];ns=name(d['metadata']['namespace']);name(d['metadata']['name']);pod=d['spec']['template']['spec'];labels=d['spec']['template']['metadata'].get('labels',{})
    if p['workload']!=ns+'/Deployment/'+d['metadata']['name'] or d.get('apiVersion')!='apps/v1' or d['spec'].get('replicas')!=1 or d['spec'].get('paused') or not labels or not matches(labels,d['spec'].get('selector',{})):raise ValueError('Invalid one-replica Deployment scope or selector')
    seen=set()
    for r in items:
        kind=r.get('kind');meta=r.get('metadata',{});key=(kind,meta.get('name'))
        if kind not in KINDS or meta.get('namespace')!=ns or key in seen or meta.get('ownerReferences') or meta.get('finalizers'):raise ValueError('Unsupported, duplicate or owned execution object')
        seen.add(key);name(meta.get('name'))
        for m in [meta,r.get('spec',{}).get('template',{}).get('metadata',{})]:
            if any(re.search(r'argocd|helm\.sh|fluxcd|external-dns',k,re.I) for k in m.get('annotations',{})):raise ValueError('Inherited reconciliation/external DNS annotations require review')
        if kind=='Service' and (r.get('apiVersion')!='v1' or r['spec'].get('type','ClusterIP')!='ClusterIP' or any(r['spec'].get(k) for k in ['externalIPs','loadBalancerIP','loadBalancerClass','externalName']) or not r['spec'].get('selector') or not matches(labels,{'matchLabels':r['spec']['selector']}) or any(x.get('nodePort') for x in r['spec'].get('ports',[]))):raise ValueError('Only isolated ClusterIP Services are supported')
    if any(pod.get(k) for k in ['hostNetwork','hostPID','hostIPC','ephemeralContainers']):raise ValueError('Unsupported Pod namespace or container scope')
    if d.get('metadata',{}).get('ownerReferences') or d['spec']['template']['metadata'].get('annotations',{}).get('k8s.v1.cni.cncf.io/networks'):raise ValueError('Owned/network-attached workload requires another path')
    for v in pod.get('volumes',[]):
        if not any(k in v for k in ['emptyDir','secret','configMap','projected','downwardAPI']):raise ValueError('Persistent/node storage is outside execution scope')
    if not pod.get('containers'):raise ValueError('Application container missing')
    for c in pod.get('containers',[])+pod.get('initContainers',[]):
        if not re.search(r'@sha256:[a-f0-9]{64}$',c.get('image','')) or c.get('securityContext',{}).get('privileged') or c.get('volumeDevices') or any(x.get('hostPort') for x in c.get('ports',[])):raise ValueError('Container needs pinned image and stateless, non-host scope')
        if any(c.get('resources',{}).get(k,{}).get('nvidia.com/gpu') for k in ['limits','requests']):raise ValueError('GPU outside execution scope')
        if any('value' not in e and 'valueFrom' not in e for e in c.get('env',[])):raise ValueError('Omitted environment value makes draft incomplete')
    for k,lo,hi in [('smokePort',1,65535),('expectedStatus',200,499),('maxLatencyMs',1,15000),('rolloutSeconds',30,900)]:
        if not isinstance(s.get(k),int) or isinstance(s[k],bool) or not lo<=s[k]<=hi:raise ValueError('Invalid execution setting')
    path=s.get('smokePath','');marker=s.get('smokeMarker','')
    if not isinstance(path,str) or len(path)>500 or not path.startswith('/') or path.startswith('//') or any(x in path for x in ['\r','\n','\x00']) or not isinstance(marker,str) or len(marker)>200:raise ValueError('Invalid smoke settings')
    return d,ns

def matches(labels,selector):
    if not isinstance(selector,dict) or not selector:return False
    if not all(labels.get(k)==v for k,v in selector.get('matchLabels',{}).items()):return False
    for e in selector.get('matchExpressions',[]):
        k=e['key'];op=e['operator'];vals=e.get('values',[])
        if op=='In' and labels.get(k) not in vals:return False
        if op=='NotIn' and k in labels and labels[k] in vals:return False
        if op=='Exists' and k not in labels:return False
        if op=='DoesNotExist' and k in labels:return False
        if op not in ['In','NotIn','Exists','DoesNotExist']:raise ValueError('Unsupported label selector operator')
    return bool(selector.get('matchLabels') or selector.get('matchExpressions'))

# Kinds that would route traffic to, or scale, the pilot the moment it exists. Optional
# APIs are only queried when the cluster serves them.
CONSUMERS=['ingresses.networking.k8s.io','horizontalpodautoscalers.autoscaling']
OPTIONAL_CONSUMERS=['httproutes.gateway.networking.k8s.io','grpcroutes.gateway.networking.k8s.io','tlsroutes.gateway.networking.k8s.io','tcproutes.gateway.networking.k8s.io','udproutes.gateway.networking.k8s.io','referencegrants.gateway.networking.k8s.io','scaledobjects.keda.sh','verticalpodautoscalers.autoscaling.k8s.io']
ROUTE_KINDS=['HTTPRoute','GRPCRoute','TLSRoute','TCPRoute','UDPRoute']

def consumers(items,ns,deployment,services):
    """Return reasons why existing target objects would reach or scale the pilot."""
    out=[];svc=set(services)
    def lst(v):return v if isinstance(v,list) else []
    for r in items:
        if not isinstance(r,dict) or r.get('metadata',{}).get('namespace',ns)!=ns:continue
        kind=r.get('kind');spec=r.get('spec') or {}
        if kind=='Ingress':
            refs=[(spec.get('defaultBackend') or {}).get('service',{}).get('name')]+[(x.get('backend') or {}).get('service',{}).get('name') for rule in lst(spec.get('rules')) for x in lst((rule.get('http') or {}).get('paths'))]
            out+=['Existing target Ingress routes to pilot Service %s; remove or repoint it first'%n for n in sorted({n for n in refs if n in svc})]
        elif kind in ROUTE_KINDS:
            refs=[b.get('name') for rule in lst(spec.get('rules')) for b in lst(rule.get('backendRefs')) if b.get('kind','Service')=='Service' and not b.get('group') and b.get('namespace',ns)==ns]
            out+=['Existing target %s routes to pilot Service %s; remove or repoint it first'%(kind,n) for n in sorted({n for n in refs if n in svc})]
        elif kind=='ReferenceGrant':
            if any(not t.get('group') and t.get('kind')=='Service' and (not t.get('name') or t.get('name') in svc) for t in lst(spec.get('to'))):out.append('ReferenceGrant lets routes in other namespaces reach pilot Services; review them first')
        elif kind in ['HorizontalPodAutoscaler','ScaledObject','VerticalPodAutoscaler']:
            ref=spec.get('targetRef' if kind=='VerticalPodAutoscaler' else 'scaleTargetRef') or {}
            if ref.get('kind','Deployment')=='Deployment' and ref.get('name')==deployment:out.append('Existing target %s targets the pilot Deployment and would change its one replica; remove it first'%kind)
    return out

def isolation(p,context,ns):
    try:served=set(command(context,['api-resources','-o','name']).split())
    except Exception:raise ValueError('Could not list target API resources; isolation cannot be verified')
    kinds=['services','deployments.apps','replicasets.apps','statefulsets.apps','daemonsets.apps','jobs.batch','cronjobs.batch','pods']+CONSUMERS+[k for k in OPTIONAL_CONSUMERS if k in served]
    items=json.loads(command(context,['get',','.join(kinds),'--namespace',ns,'-o','json'])).get('items',[])
    manifests=p['preflight']['manifests']['items'];d=next(r for r in manifests if r['kind']=='Deployment');labels=d['spec']['template']['metadata']['labels'];selector=d['spec']['selector']
    reasons=consumers(items,ns,d['metadata']['name'],[r['metadata']['name'] for r in manifests if r['kind']=='Service'])
    if reasons:raise ValueError('; '.join(reasons))
    for r in items:
        if r.get('metadata',{}).get('deletionTimestamp'):raise ValueError('Target namespace has terminating workload/service objects; resolve before isolated pilot')
        if r.get('kind') in ['Ingress','HorizontalPodAutoscaler','ReferenceGrant','ScaledObject','VerticalPodAutoscaler']+ROUTE_KINDS:continue
        if r.get('kind')=='Service':
            if r.get('spec',{}).get('selector') and matches(labels,{'matchLabels':r['spec']['selector']}):raise ValueError('Existing target Service selects the pilot labels; isolate target traffic first')
        else:
            other=r.get('spec',{}).get('jobTemplate',{}).get('spec',{}).get('template',{}).get('metadata',{}).get('labels') if r.get('kind')=='CronJob' else r.get('metadata',{}).get('labels',{}) if r.get('kind')=='Pod' else r.get('spec',{}).get('template',{}).get('metadata',{}).get('labels',{})
            if matches(other or {},selector) or matches(labels,r.get('spec',{}).get('selector',{})):raise ValueError('Existing target workload overlaps pilot labels; choose an isolated pilot')

def bind_identity(p,context):
    uid=json.loads(command(context,['get','namespaces','kube-system','-o','json'])).get('metadata',{}).get('uid')
    if uid!=p['preflight']['expectedClusterUID'] or uid==p['preflight']['sourceClusterUID']:raise ValueError('Live cluster identity differs from the intended target')

def live_checks(p,context,ns):
    bind_identity(p,context)
    report=preflight.run(p['preflight'],context)
    if not report['results'] or any(r['status']!='Pass' for r in report['results']):raise ValueError('Live target preflight has unresolved checks; no persistent create performed')
    isolation(p,context,ns)

def runtime_observations(p,context,ns,run_id,deployment_uid):
    d=next(r for r in p['preflight']['manifests']['items'] if r['kind']=='Deployment');obj=json.loads(command(context,['get','deployments.apps',d['metadata']['name'],'--namespace',ns,'-o','json']))
    if obj['metadata']['uid']!=deployment_uid or obj['metadata'].get('labels',{}).get(LABEL)!=run_id:raise ValueError('Created Deployment identity changed; stop pilot observations')
    if obj.get('spec',{}).get('replicas')!=1:raise ValueError('Live Deployment no longer has the approved single replica; an autoscaler or manual change has altered the pilot')
    replicas=json.loads(command(context,['get','replicasets.apps','--namespace',ns,'-l',LABEL+'='+run_id,'-o','json'])).get('items',[]);owners={r['metadata']['uid'] for r in replicas if any(o.get('uid')==deployment_uid and o.get('controller') for o in r['metadata'].get('ownerReferences',[]))}
    pods=json.loads(command(context,['get','pods','--namespace',ns,'-l',LABEL+'='+run_id,'-o','json'])).get('items',[]);owned=[r for r in pods if r['metadata'].get('labels',{}).get(LABEL)==run_id and not r['metadata'].get('deletionTimestamp') and any(o.get('uid') in owners and o.get('controller') for o in r['metadata'].get('ownerReferences',[]))]
    if not owned:raise ValueError('No current owned pilot Pod observed')
    expected=d['spec']['template']['spec'];images=[];all_ready=True
    for pod in owned:
        pod_ready=any(c.get('type')=='Ready' and c.get('status')=='True' for c in pod.get('status',{}).get('conditions',[]))
        for c in expected.get('containers',[])+expected.get('initContainers',[]):
            statuses=pod.get('status',{}).get('containerStatuses',[])+pod.get('status',{}).get('initContainerStatuses',[]);status=next((s for s in statuses if s.get('name')==c['name']),{});ready=status.get('ready') is True or c in expected.get('initContainers',[]) and status.get('state',{}).get('terminated',{}).get('exitCode')==0
            actual=next((x for x in pod.get('spec',{}).get('containers',[])+pod.get('spec',{}).get('initContainers',[]) if x.get('name')==c['name']),{})
            ready=bool(pod_ready and ready and actual.get('image')==c['image'] and status.get('imageID'));all_ready=all_ready and ready
            reason=status.get('state',{}).get('waiting',{}).get('reason','');reason=reason if re.fullmatch(r'[A-Za-z][A-Za-z0-9]{0,100}',reason) else ''
            images.append({'pod':pod['metadata']['name'],'container':c['name'],'image':status.get('image',actual.get('image','')),'imageID':status.get('imageID',''),'ready':ready,'reason':reason})
    return images,owned[0]['metadata']['name'],all_ready
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):return None

def http_check(port,settings):
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect());start=time.monotonic()
    try:response=opener.open('http://127.0.0.1:'+str(port)+settings['smokePath'],timeout=15)
    except urllib.error.HTTPError as e:response=e
    with response:
        code=response.code;body=response.read(1024*1024+1)
    elapsed=round((time.monotonic()-start)*1000);ok=len(body)<=1024*1024 and code==settings['expectedStatus'] and elapsed<=settings['maxLatencyMs'] and settings.get('smokeMarker','').encode() in body
    return {'status':'Pass' if ok else 'Fail','detail':'Loopback Pod HTTP GET: status %d; %d ms; configured status/latency/marker %s. Body omitted; Service/Ingress paths not tested.'%(code,elapsed,'matched' if ok else 'not matched')}

def smoke(context,ns,pod,settings):
    process=subprocess.Popen(['kubectl','--context='+context,'--namespace',ns,'port-forward','pod/'+name(pod),':'+str(settings['smokePort']),'--address=127.0.0.1','--pod-running-timeout=30s'],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True);ports=queue.Queue()
    def read():
        for line in process.stdout:
            m=re.search(r'Forwarding from 127\.0\.0\.1:(\d+)',line)
            if m:ports.put(int(m.group(1)));return
    threading.Thread(target=read,daemon=True).start()
    try:return http_check(ports.get(timeout=35),settings)
    finally:
        process.terminate()
        try:process.wait(timeout=5)
        except subprocess.TimeoutExpired:process.kill();process.wait(timeout=5)
        if process.stdout:process.stdout.close()

def run(p,context,mode,save,validation=None,confirm='',ack=False):
    d,ns=validate_plan(p,context);run_id=str(uuid.uuid4());report={'schemaVersion':1,'kind':'PilotExecutionResult','binding':p['binding'],'planRevision':p['planRevision'],'workload':p['workload'],'context':context,'clusterUID':p['preflight']['expectedClusterUID'],'runId':run_id,'mode':mode,'status':'Started','observedAt':now(),'preflightPassed':False,'created':[],'uncertain':[],'rollout':{'status':'NotRun'},'smoke':{'status':'NotRun'},'images':[],'error':'','productionReady':False};save(report)
    try:
        if mode not in ['validate','deploy']:raise ValueError('Choose validate or deploy')
        if mode=='deploy':
            if not ack or confirm!=p['workload']:raise ValueError('Deploy needs exact --confirm-workload and --ack-prerequisites')
            at=datetime.datetime.fromisoformat(validation.get('observedAt','').replace('Z','+00:00')) if validation else None
            if not validation or validation.get('schemaVersion')!=1 or validation.get('kind')!='PilotExecutionResult' or validation.get('created') or validation.get('mode')!='validate' or validation.get('status')!='Passed' or not validation.get('preflightPassed') or validation.get('binding')!=p['binding'] or validation.get('context')!=context or validation.get('clusterUID')!=report['clusterUID'] or not at or at.tzinfo is None or not -300<=(datetime.datetime.now(datetime.timezone.utc)-at).total_seconds()<=1800:raise ValueError('A passing validation of this plan/context from the last 30 minutes is required')
        live_checks(p,context,ns);report['preflightPassed']=True;save(report)
        items=copy.deepcopy(p['preflight']['manifests']['items'])
        for r in items:
            r['metadata'].setdefault('labels',{})[LABEL]=run_id
            if r['kind']=='Deployment':r['spec']['selector'].setdefault('matchLabels',{})[LABEL]=run_id;r['spec']['template']['metadata'].setdefault('labels',{})[LABEL]=run_id
            else:r['spec']['selector'][LABEL]=run_id
        command(context,['create','--dry-run=server','--validate=true','-f','-','-o','name'],json.dumps({'apiVersion':'v1','kind':'List','items':items}))
        if mode=='validate':report['status']='Passed';return report
        for r in sorted(items,key=lambda x:x['kind']=='Deployment'):
            bind_identity(p,context)
            item={'kind':r['kind'],'name':r['metadata']['name'],'namespace':ns};report['uncertain'].append(r['kind']+'/'+r['metadata']['name']);save(report)
            try:created=json.loads(command(context,['create','--validate=true','-f','-','-o','json'],json.dumps(r)))
            except Exception:
                # A failed response may follow a successful API create; recover only a matching run label.
                try:
                    raw=command(context,['get',KINDS[r['kind']],r['metadata']['name'],'--namespace',ns,'--ignore-not-found=true','-o','json']);obj=json.loads(raw) if raw.strip() else {}
                    if obj.get('metadata',{}).get('labels',{}).get(LABEL)==run_id and obj.get('metadata',{}).get('uid'):report['created'].append({**item,'uid':obj['metadata']['uid']});save(report)
                except Exception:pass
                raise
            uid=created.get('metadata',{}).get('uid')
            if not uid or created.get('metadata',{}).get('labels',{}).get(LABEL)!=run_id:raise ValueError('Create response lacks expected ownership label or UID; inspect uncertain outcome')
            report['created'].append({**item,'uid':uid});report['uncertain'].remove(r['kind']+'/'+r['metadata']['name']);save(report)
        try:command(context,['rollout','status','deployment/'+d['metadata']['name'],'--namespace',ns,'--timeout='+str(p['settings']['rolloutSeconds'])+'s'],timeout=p['settings']['rolloutSeconds']+30);report['rollout']={'status':'Pass','detail':'kubectl rollout status completed for the created Deployment'}
        except Exception:
            report['rollout']={'status':'Error','detail':'Rollout failed or timed out; inspect target locally and follow recovery receipt'}
            try:
                deployment_uid=next(x['uid'] for x in report['created'] if x['kind']=='Deployment');report['images'],_,_=runtime_observations(p,context,ns,run_id,deployment_uid)
            except Exception:pass
            raise
        save(report);uid=next(x['uid'] for x in report['created'] if x['kind']=='Deployment');report['images'],pod,images_ready=runtime_observations(p,context,ns,run_id,uid);save(report)
        if not images_ready:raise ValueError('Expected owned Pod/container image startup observations remain unresolved')
        try:report['smoke']=smoke(context,ns,pod,p['settings'])
        except Exception:report['smoke']={'status':'Error','detail':'Loopback smoke probe or port-forward failed; inspect the approved Pod and port locally'};raise
        report['status']='Passed' if report['smoke']['status']=='Pass' else 'Failed'
    except Exception as error:
        report['status']='Failed';report['error']=str(error) if isinstance(error,ValueError) else 'Local runner or kubectl operation failed. Inspect intended target locally; raw diagnostics omitted. Keep this partial receipt and follow RECOVERY.md.'
    finally:report['observedAt']=now();save(report)
    return report

def receipt_scope(p,context,receipt):
    validate_plan(p,context)
    if not isinstance(receipt,dict) or any(receipt.get(k)!=p[k] for k in ['binding','planRevision','workload']) or receipt.get('schemaVersion')!=1 or receipt.get('kind')!='PilotExecutionResult' or receipt.get('mode')!='deploy' or receipt.get('status') not in ['Started','Failed','Passed'] or receipt.get('context')!=context or receipt.get('clusterUID')!=p['preflight']['expectedClusterUID'] or not re.fullmatch(r'[a-z0-9-]{1,80}',receipt.get('runId','')):raise ValueError('Original deploy receipt must match this plan, context and target cluster')
    expected={(x['kind'],x['metadata']['name'],x['metadata']['namespace']) for x in p['preflight']['manifests']['items']};created=receipt.get('created');uncertain=receipt.get('uncertain',[])
    if not isinstance(created,list) or len(created)>11 or not isinstance(uncertain,list) or len(uncertain)>11:raise ValueError('Invalid deploy receipt object scope')
    seen=set()
    for x in created:
        key=(x.get('kind'),x.get('name'),x.get('namespace'))
        if key not in expected or key in seen or not isinstance(x.get('uid'),str) or not x['uid'] or len(x['uid'])>200:raise ValueError('Unknown, duplicate or UID-less deploy receipt object')
        seen.add(key)
    if any(not isinstance(x,str) or x not in {kind+'/'+name for kind,name,ns in expected} for x in uncertain):raise ValueError('Unknown uncertain create in receipt')
    return expected

def recovery_snapshot(p,context,receipt):
    bind_identity(p,context);created={(x['kind'],x['name']):x['uid'] for x in receipt['created']};uncertain=set(receipt.get('uncertain',[]));rows=[]
    for planned in p['preflight']['manifests']['items']:
        kind=planned['kind'];meta=planned['metadata'];ns=name(meta['namespace']);resource=name(meta['name']);known=created.get((kind,resource),'');row={'kind':kind,'name':resource,'namespace':ns,'receiptUID':known,'uid':'','resourceVersion':'','state':'Error','runLabelMatch':False,'finalizers':0,'detail':''}
        try:
            raw=command(context,['get',KINDS[kind],resource,'--namespace',ns,'--ignore-not-found=true','-o','json']);obj=json.loads(raw) if raw.strip() else None
            if obj is None and not raw.strip():row.update(state='Absent',detail='Named object not observed')
            else:
                live=obj.get('metadata',{});uid=live.get('uid');version=live.get('resourceVersion');label=live.get('labels',{}).get(LABEL)==receipt['runId']
                if obj.get('kind')!=kind or live.get('name')!=resource or live.get('namespace')!=ns or not isinstance(uid,str) or not uid or not isinstance(version,str) or not version:raise ValueError('Live object identity/version is incomplete')
                row.update(uid=uid,resourceVersion=version,runLabelMatch=label,finalizers=len(live.get('finalizers',[])))
                spec=obj.get('spec',{});pod=spec.get('template',{}).get('spec',{});scope_ok=(spec.get('selector',{}).get(LABEL)==receipt['runId'] and spec.get('type','ClusterIP')=='ClusterIP' and not any(spec.get(k) for k in ['externalIPs','loadBalancerIP','loadBalancerClass','externalName'])) if kind=='Service' else (spec.get('selector',{}).get('matchLabels',{}).get(LABEL)==receipt['runId'] and spec.get('template',{}).get('metadata',{}).get('labels',{}).get(LABEL)==receipt['runId'] and not any(not any(k in v for k in ['emptyDir','secret','configMap','projected','downwardAPI']) for v in pod.get('volumes',[])))
                if not label or known and uid!=known or live.get('ownerReferences') or not scope_ok:row.update(state='Mismatch',detail='UID, run label, isolated selector or stateless scope differs, or owner references exist; manual review required')
                elif not known and kind+'/'+resource not in uncertain:row.update(state='Mismatch',detail='Object was not recorded or marked uncertain in this receipt; obtain the latest receipt')
                elif live.get('deletionTimestamp'):row.update(state='Terminating',detail='Deletion is already in progress; no force or finalizer removal offered')
                elif known:row.update(state='Owned',detail='Recorded UID and run label match; review current resource version before cleanup')
                else:row.update(state='Recovered',detail='Run-labeled object observed after an uncertain create; review recovered UID before cleanup')
        except Exception:row.update(state='Error',detail='Object read/identity check failed; raw diagnostics omitted')
        rows.append(row)
    ns=p['preflight']['manifests']['items'][0]['metadata']['namespace'];raw=json.loads(command(context,['get','replicasets.apps,pods','--namespace',ns,'-l',LABEL+'='+receipt['runId'],'-o','json']));dependents=[]
    if not isinstance(raw,dict) or not isinstance(raw.get('items'),list):raise ValueError('Descendant query is incomplete')
    for obj in raw.get('items',[]):
        if len(dependents)>=200:raise ValueError('More than 200 run-labeled descendants; review manually')
        meta=obj.get('metadata',{})
        if obj.get('kind') not in ['Pod','ReplicaSet'] or meta.get('namespace')!=ns or meta.get('labels',{}).get(LABEL)!=receipt['runId'] or not isinstance(meta.get('uid'),str) or not meta['uid']:raise ValueError('Unexpected descendant query scope')
        dependents.append({'kind':obj['kind'],'name':name(meta['name']),'namespace':ns,'uid':meta.get('uid',''),'state':'Terminating' if meta.get('deletionTimestamp') else 'Present'})
    blocked=any(x['state'] in ['Mismatch','Error'] for x in rows);status='Blocked' if blocked else 'Absent' if all(x['state']=='Absent' for x in rows) and not dependents else 'ReviewRequired'
    return rows,dependents,status

def inspection_scope(p,receipt,inspection):
    if not isinstance(inspection,dict) or inspection.get('schemaVersion')!=1 or inspection.get('kind')!='PilotInspectionResult' or any(inspection.get(k)!=receipt.get(k) for k in ['binding','planRevision','workload','context','clusterUID','runId']) or inspection.get('status') not in ['ReviewRequired','Absent'] or not re.fullmatch(r'[a-z0-9-]{1,80}',inspection.get('inspectionId','')):raise ValueError('Use a matching, unblocked inspection before cleanup')
    at=datetime.datetime.fromisoformat(inspection.get('observedAt','').replace('Z','+00:00'))
    if at.tzinfo is None or not -300<=(datetime.datetime.now(datetime.timezone.utc)-at).total_seconds()<=600:raise ValueError('Inspection is older than ten minutes or has an invalid timestamp; inspect again')
    expected={(x['kind'],x['metadata']['name'],x['metadata']['namespace']) for x in p['preflight']['manifests']['items']};rows=inspection.get('rows',[])
    if not isinstance(rows,list) or len(rows)!=len(expected) or {(x.get('kind'),x.get('name'),x.get('namespace')) for x in rows}!=expected:raise ValueError('Inspection object coverage differs from the original plan')
    known={(x['kind'],x['name']):x['uid'] for x in receipt['created']};uncertain=set(receipt.get('uncertain',[]))
    for x in rows:
        state=x.get('state');uid=x.get('uid');version=x.get('resourceVersion');original=known.get((x['kind'],x['name']))
        if state not in ['Owned','Recovered','Absent','Terminating']:raise ValueError('Inspection contains unresolved identity/read errors')
        if state!='Absent' and (not isinstance(uid,str) or not uid or not isinstance(version,str) or not version or x.get('runLabelMatch') is not True or original and uid!=original or not original and x['kind']+'/'+x['name'] not in uncertain):raise ValueError('Inspection UID/version is not bound to this run receipt')
    return rows

def recovery_run(p,context,receipt,mode,save,inspection=None,confirm='',ack=False):
    receipt_scope(p,context,receipt)
    if mode not in ['inspect','cleanup']:raise ValueError('Choose inspect or cleanup')
    report={k:receipt[k] for k in ['binding','planRevision','workload','context','clusterUID','runId']};report.update(schemaVersion=1,kind='PilotInspectionResult' if mode=='inspect' else 'PilotCleanupResult',inspectionId=str(uuid.uuid4()) if mode=='inspect' else (inspection or {}).get('inspectionId',''),status='Started',observedAt=now(),rows=[],dependents=[],actions=[],error='',productionReady=False);save(report)
    try:
        if mode=='inspect':report['rows'],report['dependents'],report['status']=recovery_snapshot(p,context,receipt);return report
        if confirm!=receipt['runId'] or not ack:raise ValueError('Cleanup needs exact --confirm-run and --ack-external-state after owner review of writers, recovery and external effects')
        reviewed=inspection_scope(p,receipt,inspection);live,children,state=recovery_snapshot(p,context,receipt)
        if state=='Blocked':raise ValueError('Current resource identity/read checks block cleanup')
        frozen={(x['kind'],x['name']):x for x in reviewed}
        for x in live:
            old=frozen[(x['kind'],x['name'])]
            if any(x[k]!=old[k] for k in ['uid','resourceVersion','state','runLabelMatch']):raise ValueError('Resource changed since inspection; inspect again before cleanup')
        report['rows']=live;report['dependents']=children;save(report)
        for x in sorted(live,key=lambda row:row['kind']=='Deployment'):
            if x['state'] in ['Absent','Terminating']:continue
            bind_identity(p,context)
            raw=command(context,['get',KINDS[x['kind']],name(x['name']),'--namespace',name(x['namespace']),'--ignore-not-found=true','-o','json']);current=json.loads(raw) if raw.strip() else {};meta=current.get('metadata',{})
            if meta.get('uid')!=x['uid'] or meta.get('resourceVersion')!=x['resourceVersion'] or meta.get('labels',{}).get(LABEL)!=receipt['runId'] or meta.get('ownerReferences') or meta.get('deletionTimestamp'):raise ValueError('Object changed immediately before delete; inspect again')
            action={k:x[k] for k in ['kind','name','namespace','uid','resourceVersion']};action['outcome']='Requesting';report['actions'].append(action);save(report)
            prefix='/apis/apps/v1/namespaces/' if x['kind']=='Deployment' else '/api/v1/namespaces/';plural='deployments' if x['kind']=='Deployment' else 'services';path=prefix+name(x['namespace'])+'/'+plural+'/'+name(x['name'])
            body={'apiVersion':'v1','kind':'DeleteOptions','preconditions':{'uid':x['uid'],'resourceVersion':x['resourceVersion']},'propagationPolicy':'Foreground'}
            try:command(context,['delete','--raw='+path,'-f','-'],json.dumps(body));action['outcome']='Requested';save(report)
            except Exception:action['outcome']='Error';save(report);raise
        report['rows'],report['dependents'],state=recovery_snapshot(p,context,receipt);report['status']='Absent' if state=='Absent' else 'Blocked' if state=='Blocked' else 'Pending'
    except Exception as error:report['status']='Error' if mode=='inspect' else 'Failed';report['error']=str(error) if isinstance(error,ValueError) else 'Recovery request/read failed. A failed response may still have requested deletion; inspect again. Raw diagnostics omitted.'
    finally:report['observedAt']=now();save(report)
    return report

def observe_run(p,context,receipt,save):
    expected=receipt_scope(p,context,receipt);report={k:receipt[k] for k in ['binding','planRevision','workload','context','clusterUID','runId']};report.update(schemaVersion=1,kind='PilotObservationResult',mode='observe',status='Started',observedAt=now(),identityMatched=False,rollout={'status':'NotRun'},smoke={'status':'NotRun'},images=[],error='',productionReady=False);save(report)
    try:
        if len(receipt['created'])!=len(expected):raise ValueError('Observation requires recorded UIDs for every planned root; inspect uncertain/partial creates first')
        rows,_,state=recovery_snapshot(p,context,receipt)
        if state=='Blocked' or any(x['state']!='Owned' for x in rows):raise ValueError('A recorded pilot root is absent, changed, terminating or unreadable; inspect recovery before probing')
        report['identityMatched']=True;save(report);d=next(x for x in receipt['created'] if x['kind']=='Deployment');ns=d['namespace']
        try:command(context,['rollout','status','deployment/'+d['name'],'--namespace',ns,'--timeout='+str(p['settings']['rolloutSeconds'])+'s'],timeout=p['settings']['rolloutSeconds']+30);report['rollout']={'status':'Pass','detail':'Recorded Deployment rollout observed without modifying resources'}
        except Exception:
            report['rollout']={'status':'Error','detail':'Rollout failed/timed out; inspect current target and recovery state'}
            try:bind_identity(p,context);report['images'],_,_=runtime_observations(p,context,ns,receipt['runId'],d['uid'])
            except Exception:pass
            raise
        save(report);bind_identity(p,context);report['images'],pod,images_ready=runtime_observations(p,context,ns,receipt['runId'],d['uid']);save(report)
        if not images_ready:raise ValueError('Current owned Pod/container startup or image observations are unresolved')
        bind_identity(p,context)
        try:report['smoke']=smoke(context,ns,pod,p['settings'])
        except Exception:report['smoke']={'status':'Error','detail':'Approved loopback HTTP probe or port-forward failed; inspect the target locally'};raise
        report['identityMatched']=False
        rows,_,state=recovery_snapshot(p,context,receipt)
        if state=='Blocked' or any(x['state']!='Owned' for x in rows):raise ValueError('Pilot root identity/scope changed during observation; inspect recovery')
        report['identityMatched']=True
        report['status']='Passed' if report['smoke']['status']=='Pass' else 'Failed'
    except Exception as error:report['status']='Failed';report['error']=str(error) if isinstance(error,ValueError) else 'Observation failed; raw diagnostics omitted. No resource creation, update or deletion was requested.'
    finally:report['observedAt']=now();save(report)
    return report

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('mode',choices=['validate','deploy','inspect','cleanup','observe']);parser.add_argument('--context',required=True);parser.add_argument('--plan',default='execution-plan.json');parser.add_argument('--output',required=True);parser.add_argument('--validation');parser.add_argument('--confirm-workload',default='');parser.add_argument('--ack-prerequisites',action='store_true');parser.add_argument('--receipt');parser.add_argument('--inspection');parser.add_argument('--confirm-run',default='');parser.add_argument('--ack-external-state',action='store_true');a=parser.parse_args()
    with open(a.plan,encoding='utf8') as f:p=json.load(f)
    validate_plan(p,a.context);validation=None
    if a.validation:
        with open(a.validation,encoding='utf8') as f:validation=json.load(f)
    receipt=None;inspection=None
    if a.mode in ['inspect','cleanup','observe']:
        if not a.receipt:raise ValueError('--receipt is required for existing-run modes')
        with open(a.receipt,encoding='utf8') as f:receipt=json.load(f)
        receipt_scope(p,a.context,receipt)
        if a.mode=='cleanup':
            if not a.inspection:raise ValueError('--inspection is required for cleanup')
            with open(a.inspection,encoding='utf8') as f:inspection=json.load(f)
    fd=os.open(a.output,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600);os.close(fd)
    def save(report):
        temporary=None
        try:
            with tempfile.NamedTemporaryFile(mode='w',encoding='utf8',dir=str(Path(a.output).parent),prefix='.pilot-receipt-',delete=False) as f:
                temporary=f.name;json.dump(report,f,indent=2);f.flush();os.fsync(f.fileno())
            os.replace(temporary,a.output);temporary=None
        finally:
            if temporary:os.unlink(temporary)
    report=observe_run(p,a.context,receipt,save) if a.mode=='observe' else recovery_run(p,a.context,receipt,a.mode,save,inspection,a.confirm_run,a.ack_external_state) if a.mode in ['inspect','cleanup'] else run(p,a.context,a.mode,save,validation,a.confirm_workload,a.ack_prerequisites)
    print('Pilot %s: %s. Keep the receipt; production readiness remains unverified.'%(a.mode,report['status']));return 0 if report['status'] in ['Passed','ReviewRequired','Absent'] else 1
if __name__=='__main__':sys.exit(main())
