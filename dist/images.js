(function(root){
'use strict';
function parse(reference){
 if(typeof reference!=='string'||!reference||reference.length>512||/\s|:\/\/|[^a-zA-Z0-9._:/@-]/.test(reference))throw Error('Use a registry image reference without credentials, a URL scheme or whitespace.');
 const parts=reference.split('@');if(parts.length>2)throw Error('Invalid image digest.');const digest=parts[1]||'';if(digest&&!/^sha256:[a-f0-9]{64}$/.test(digest))throw Error('This planner supports sha256 digest references only.');
 let name=parts[0],tag='';if(name.lastIndexOf(':')>name.lastIndexOf('/')){tag=name.slice(name.lastIndexOf(':')+1);name=name.slice(0,name.lastIndexOf(':'));if(!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(tag))throw Error('Invalid image tag.');}
 const chunks=name.split('/');let registry='docker.io';if(chunks.length>1&&(/[.:]/.test(chunks[0])||chunks[0]==='localhost'))registry=chunks.shift();
 if(!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?$/.test(registry))throw Error('Invalid registry host or port. IPv6 references require manual handling.');
 if(registry==='index.docker.io')registry='docker.io';if(registry==='docker.io'&&chunks.length===1)chunks.unshift('library');
 const repository=chunks.join('/');if(!repository||!chunks.every(x=>/^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/.test(x)))throw Error('Invalid repository path. Use lowercase repository names.');
 return {registry,repository,tag,digest,repo:registry+'/'+repository,canonical:registry+'/'+repository+(digest?'@'+digest:':'+(tag||'latest'))};
}
function plan(images,options={}){
 const policy=options.policy||'Reuse registry',rows=[],errors=[];let prefix=null;
 if(!['Reuse registry','Mirror to Harbor','Migrate to Harbor'].includes(policy))errors.push('Select a supported image strategy.');
 if(policy!=='Reuse registry')try{prefix=parse(options.prefix||'');if(prefix.digest||prefix.tag||prefix.registry==='docker.io')throw Error('Use an explicit destination registry host/project with no tag or digest.');}catch(e){errors.push('Destination: '+e.message);}
 for(const entry of images){try{const src=parse(entry.image);let destination=src.canonical;if(policy!=='Reuse registry'&&prefix){const ns=src.registry.replace(/:/g,'-');destination=prefix.repo+'/'+ns+'/'+src.repository+':'+(src.tag||(src.digest?'sha256-'+src.digest.slice(7):'latest'));}if(options.overrides?.[entry.image])destination=parse(options.overrides[entry.image]).canonical;const dest=parse(destination);if(policy!=='Reuse registry'&&dest.digest)throw Error('Use a destination tag for copying; a digest pin will be available from verification results.');if(policy==='Reuse registry'&&dest.canonical!==src.canonical)throw Error('Reuse registry must retain the original image. Select a copy strategy to change repositories.');rows.push({source:entry.image,sourceCanonical:src.canonical,sourceRepo:src.repo,destination:dest.canonical,destinationRepo:dest.repo,operation:policy==='Reuse registry'?'Reuse':'Copy',workloads:[...new Set(entry.workloads||[])],sourcePinned:!!src.digest,status:'Not checked'});}catch(e){errors.push(entry.image+': '+e.message);}}
 const destinations=new Map();for(const row of rows){const previous=destinations.get(row.destination);if(previous&&previous!==row.sourceCanonical)errors.push('Destination collision: '+row.destination);destinations.set(row.destination,row.sourceCanonical);}
 return {schemaVersion:1,policy,rows,errors,productionReady:false,verificationScope:'Registry manifest digest only; signatures, referrers/SBOMs, scanning, architecture compatibility and VKS node pull access require separate validation.'};
}
function evidence(plan,input){
 if(input?.schemaVersion!==1||!Array.isArray(input.results)||input.results.length>30000)throw Error('Expected image runner results with schemaVersion 1 and a results array.');
 const rows=[],seen=new Set();for(const result of input.results){const expected=plan.rows.find(r=>r.source===result.source&&r.sourceCanonical===result.sourceCanonical&&r.destination===result.destination&&r.operation===result.operation);if(!expected)throw Error('Results do not match the current image plan. Restore its settings or run the current plan.');if(seen.has(result.source))throw Error('Duplicate image result.');seen.add(result.source);const digest=result.sourceDigest,dest=result.destinationDigest,match=/^sha256:[a-f0-9]{64}$/.test(digest||'')&&digest===dest&&!result.error&&result.status==='Registry digest match';if(match&&parse(expected.sourceCanonical).digest&&parse(expected.sourceCanonical).digest!==digest)throw Error('Reported digest conflicts with the pinned source.');rows.push({source:expected.source,destination:expected.destination,sourceDigest:/^sha256:[a-f0-9]{64}$/.test(digest||'')?digest:null,destinationDigest:/^sha256:[a-f0-9]{64}$/.test(dest||'')?dest:null,status:match?'Reported digest match':'Reported failure',pinnedDestination:match?expected.destinationRepo+'@'+digest:null});}
 return {schemaVersion:1,importedAt:new Date().toISOString(),results:rows,productionReady:false,note:'Externally supplied results are not independently authenticated or retested by this app. Registry digest match does not establish target-cluster pull or security readiness.'};
}
root.MigrationImages={parse,plan,evidence};if(typeof module!=='undefined')module.exports=root.MigrationImages;
})(typeof window!=='undefined'?window:globalThis);
