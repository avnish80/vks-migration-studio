"""collect.py must not export kubectl diagnostics or GitOps values that carry credentials."""
import json,os,subprocess,sys,tempfile,textwrap,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parent
FAKE=textwrap.dedent('''\
    #!/usr/bin/env python3
    import json,sys
    args=sys.argv[1:]
    def out(items):print(json.dumps({'items':items}));sys.exit(0)
    if 'version' in args:print(json.dumps({'serverVersion':{'gitVersion':'v1.33.1'}}));sys.exit(0)
    if 'api-resources' in args:print('helmreleases.helm.toolkit.fluxcd.io\\napplications.argoproj.io\\nkustomizations.kustomize.toolkit.fluxcd.io');sys.exit(0)
    if 'api-versions' in args:print('v1\\napps/v1');sys.exit(0)
    kind=args[args.index('get')+1]
    if kind=='roles':sys.stderr.write('Error from server (Forbidden): roles is forbidden: User "admin@vsphere.local" cannot list SECRET_TOKEN at https://10.0.0.5:6443');sys.exit(1)
    if kind=='nodes':sys.stderr.write('Unable to connect to the server: dial tcp 10.0.0.5:6443: connection refused');sys.exit(1)
    if kind.startswith('helmreleases'):out([{'apiVersion':'helm.toolkit.fluxcd.io/v2','kind':'HelmRelease','metadata':{'name':'db','namespace':'app'},'spec':{'chart':{'spec':{'chart':'postgres'}},'values':{'auth':{'password':'HR_PLAINTEXT_PW'}}}}])
    if kind.startswith('applications'):out([{'apiVersion':'argoproj.io/v1alpha1','kind':'Application','metadata':{'name':'web','namespace':'argocd'},'spec':{'source':{'repoURL':'https://git.example.com/web','helm':{'values':'apiKey: ARGO_PLAINTEXT_KEY','valuesObject':{'k':'ARGO_OBJECT_KEY'},'parameters':[{'name':'pw','value':'ARGO_PARAM'}],'releaseName':'web'}},'sources':[{'plugin':{'env':[{'name':'TOKEN','value':'ARGO_PLUGIN_ENV'}]}}]}}])
    if kind.startswith('kustomizations'):out([{'apiVersion':'kustomize.toolkit.fluxcd.io/v1','kind':'Kustomization','metadata':{'name':'apps','namespace':'flux'},'spec':{'path':'./apps','postBuild':{'substitute':{'DB_PASSWORD':'FLUX_SUBST_PW'}}}}])
    if kind=='deployments':out([{'apiVersion':'apps/v1','kind':'Deployment','metadata':{'name':'web','namespace':'app'},'spec':{'selector':{'matchExpressions':[{'key':'tier','operator':'In','values':['web']}]},'template':{'spec':{'containers':[{'name':'web','image':'nginx','env':[{'name':'PW','value':'ENV_PW'}]}]}}}}])
    out([])
''')
class Collector(unittest.TestCase):
    def run_collector(self):
        tmp=tempfile.mkdtemp();kubectl=Path(tmp)/'kubectl';kubectl.write_text(FAKE);kubectl.chmod(0o755);output=Path(tmp)/'inventory.json'
        env={**os.environ,'PATH':tmp+os.pathsep+os.environ['PATH']}
        subprocess.run([sys.executable,'-I','-B',str(ROOT/'dist'/'collect.py'),'--context','lab','--output',str(output)],env=env,check=True,capture_output=True,timeout=60)
        return output.read_text(),json.loads(output.read_text())
    def test_no_secrets_or_raw_diagnostics_exported(self):
        raw,inv=self.run_collector()
        for secret in ['HR_PLAINTEXT_PW','ARGO_PLAINTEXT_KEY','ARGO_OBJECT_KEY','ARGO_PARAM','ARGO_PLUGIN_ENV','FLUX_SUBST_PW','ENV_PW','SECRET_TOKEN','admin@vsphere.local','10.0.0.5']:
            self.assertNotIn(secret,raw,secret+' leaked into the inventory')
        reasons={e['resource']:e['reason'] for e in inv['collection']['errors']}
        self.assertEqual(reasons['roles'],'Forbidden');self.assertEqual(reasons['nodes'],'Unreachable')
    def test_useful_fields_are_kept(self):
        _,inv=self.run_collector();by={i['kind']:i for i in inv['items']}
        self.assertEqual(by['HelmRelease']['spec']['chart']['spec']['chart'],'postgres')
        self.assertEqual(by['Application']['spec']['source']['helm']['releaseName'],'web')
        self.assertEqual(by['Kustomization']['spec']['path'],'./apps')
        self.assertEqual(by['Deployment']['spec']['selector']['matchExpressions'][0]['values'],['web'],'selector values must survive')
class Browser(unittest.TestCase):
    def test_engine_applies_the_same_redaction(self):
        script='''const E=require('./dist/engine.js');const inv=E.normalize({items:[
{kind:'HelmRelease',metadata:{name:'db'},spec:{values:{pw:'HR_PLAINTEXT_PW'},chart:{spec:{chart:'postgres'}}}},
{kind:'Application',metadata:{name:'web'},spec:{source:{helm:{values:'ARGO_PLAINTEXT_KEY',valuesObject:{k:'ARGO_OBJECT_KEY'}}},template:{spec:{sources:[{helm:{values:'TEMPLATE_KEY'}}]}}}},
{kind:'ApplicationSet',metadata:{name:'set'},spec:{template:{spec:{source:{plugin:{env:[{name:'T'}]}}}}}},
{kind:'Kustomization',metadata:{name:'apps'},spec:{postBuild:{substitute:{P:'FLUX_SUBST_PW'}},path:'./apps'}}]});
process.stdout.write(JSON.stringify(inv.items));'''
        out=subprocess.run(['node','-e',script],cwd=ROOT,capture_output=True,text=True,check=True).stdout
        for secret in ['HR_PLAINTEXT_PW','ARGO_PLAINTEXT_KEY','ARGO_OBJECT_KEY','TEMPLATE_KEY','FLUX_SUBST_PW','"env"']:self.assertNotIn(secret,out)
        self.assertIn('postgres',out);self.assertIn('./apps',out)
if __name__=='__main__':unittest.main()
