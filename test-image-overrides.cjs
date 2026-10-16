// Image overrides must not overwrite source images or escape the destination prefix.
const assert=require('node:assert/strict'),I=require('./dist/images');
const images=[{image:'registry.example.com/team/a:1',workloads:['app/Deployment/a']},{image:'registry.example.com/team/b:1',workloads:['app/Deployment/b']}];
const base={policy:'Mirror to Harbor',prefix:'harbor.example.com/proj'};
const plan=overrides=>I.plan(images,{...base,overrides});
assert.deepEqual(plan({}).errors,[]);
// Allowed: an override that stays under the destination prefix.
const ok=plan({'registry.example.com/team/a:1':'harbor.example.com/proj/apps/a:1'});
assert.deepEqual(ok.errors,[]);assert.equal(ok.rows[0].destination,'harbor.example.com/proj/apps/a:1');
// Refused: onto another row's source, onto Docker Hub, onto its own source, onto a sibling project.
for(const [label,target] of [['another source','registry.example.com/team/b:1'],['Docker Hub','myorg/nginx:1.27'],['itself','registry.example.com/team/a:1'],['sibling project','harbor.example.com/proj-other/a:1']]){
 const result=plan({'registry.example.com/team/a:1':target});
 assert(result.errors.some(e=>/destination|Override/.test(e)),label+' must be refused: '+JSON.stringify(result.errors));
}
// A source already inside the prefix must still not be a copy destination for another image.
const inside=I.plan([{image:'harbor.example.com/proj/x:1'},{image:'registry.example.com/y:1'}],{...base,overrides:{'registry.example.com/y:1':'harbor.example.com/proj/x:1'}});
assert(inside.errors.some(e=>e.includes('source image in this plan')),JSON.stringify(inside.errors));
// Reuse policy is unchanged.
assert.deepEqual(I.plan(images,{policy:'Reuse registry'}).errors,[]);
console.log('Image override tests passed: overrides stay under the prefix; no copy may target a source image.');
