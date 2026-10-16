#!/usr/bin/env python3
"""Run a reviewed VKS Migration Studio image plan locally with Skopeo.
Default: registry manifest verification only. --copy writes destination tags and
may overwrite existing tags. No source deletions or Kubernetes operations occur.
Authenticate using skopeo login locally. Never put credentials in the plan.
"""
import argparse, datetime, hashlib, json, os, re, subprocess, sys

def valid_ref(value):
    if not isinstance(value,str) or len(value)>512 or not re.fullmatch(r'[a-zA-Z0-9._:/@-]+',value) or '://' in value or '/' not in value:
        raise ValueError('Invalid fully qualified registry reference')
    return value

def command(args):
    result=subprocess.run(['skopeo']+args,capture_output=True,timeout=900)
    if result.returncode:
        # Registry stderr may contain service-specific diagnostics or credentials.
        # Keep those local instead of writing them into importable reports.
        raise RuntimeError('Skopeo command failed (exit %s). Inspect local registry access, trust and permissions.' % result.returncode)
    return result.stdout

def inspect(reference):
    raw=command(['inspect','--raw','docker://'+valid_ref(reference)])
    manifest=json.loads(raw)
    if manifest.get('schemaVersion')!=2:raise ValueError('Only OCI/Docker schema 2 manifests are supported; convert legacy images separately')
    return 'sha256:'+hashlib.sha256(raw).hexdigest(), [{'os':x.get('platform',{}).get('os'),'architecture':x.get('platform',{}).get('architecture'),'variant':x.get('platform',{}).get('variant')} for x in manifest.get('manifests',[])]

def run(plan,copy=False):
    if plan.get('schemaVersion')!=1 or plan.get('errors') or not isinstance(plan.get('rows'),list) or len(plan['rows'])>30000:
        raise ValueError('Plan is invalid or has unresolved errors')
    rows=[r for r in plan['rows'] if isinstance(r,dict)]
    if len(rows)!=len(plan['rows']):raise ValueError('Plan rows must be objects')
    sources={r.get('sourceCanonical') for r in rows};copies=[r.get('destination') for r in rows if r.get('operation')=='Copy']
    if any(d in sources for d in copies):raise ValueError('A copy destination is also a source image in this plan; refusing to overwrite it')
    if len(set(copies))!=len(copies):raise ValueError('Two rows copy to the same destination; refusing an ambiguous plan')
    results=[]
    for row in plan['rows']:
        item={key:row.get(key) for key in ['source','sourceCanonical','destination','operation']}
        item.update(status='Failed',copied=False)
        try:
            source=valid_ref(row['sourceCanonical']);destination=valid_ref(row['destination'])
            if row.get('operation') not in ['Reuse','Copy']:raise ValueError('Unsupported operation')
            if row['operation']=='Reuse' and source!=destination:raise ValueError('Reuse references must match')
            source_digest,platforms=inspect(source)
            if '@' in source and source.rsplit('@',1)[1]!=source_digest:raise ValueError('Source manifest differs from its requested digest pin')
            item.update(sourceDigest=source_digest,platforms=platforms)
            repo=source.split('@')[0]
            if repo.rfind(':')>repo.rfind('/'):repo=repo[:repo.rfind(':')]
            pinned=repo+'@'+source_digest
            if copy and row['operation']=='Copy':
                command(['copy','--all','--preserve-digests','docker://'+pinned,'docker://'+destination]);item['copied']=True
            destination_digest,_=inspect(destination)
            item['destinationDigest']=destination_digest
            if source_digest!=destination_digest:raise ValueError('Source and destination manifest digests differ')
            item['status']='Registry digest match'
        except (ValueError,KeyError,TypeError,RuntimeError,OSError,subprocess.TimeoutExpired) as error:
            item['error']=str(error)
        results.append(item)
    return {'schemaVersion':1,'collectedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'mode':'copy-and-verify' if copy else 'verify-only','results':results,'productionReady':False,'limitations':['Registry digest comparison only; no VKS pull or application test.','Multi-platform descriptor metadata may not describe a single-platform manifest. Verify required platform separately.','Signatures, OCI referrers, SBOMs and vulnerability status require separate verification.','Copy mode writes destination tags and may overwrite them. It never deletes source images.']}

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plan',default='image-plan.json')
    parser.add_argument('--output',default='image-results.json')
    parser.add_argument('--copy',action='store_true',help='Write destination tags (may overwrite); then compare registry manifest digests')
    args=parser.parse_args()
    # Reserve the report path before any registry writes; never overwrite reports.
    with open(args.plan,encoding='utf-8') as stream:plan=json.load(stream)
    fd=os.open(args.output,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,'w') as stream:
        report=run(plan,args.copy);json.dump(report,stream,indent=2)
    failed=sum(x['status']!='Registry digest match' for x in report['results'])
    print('Wrote registry results: %s; %d image(s), %d failure(s). No Kubernetes changes.' % (args.output,len(report['results']),failed))
    return 1 if failed else 0

if __name__=='__main__':sys.exit(main())
