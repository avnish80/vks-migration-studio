(function(root){
'use strict';
const groups=[
 {id:'overview',icon:'◫',label:'Migration dashboard',views:['overview']},
 {id:'inventory',icon:'▦',label:'Discover & assess',views:['inventory','changes','dependencies','findings']},
 {id:'compare',icon:'⇄',label:'Destination & controls',views:['compare','security','storage']},
 {id:'pilot',icon:'▷',label:'Prepare pilot',views:['pilot','images','routing']},
 {id:'target',icon:'⚙',label:'Validate & hand off',views:['target','acceptance','gitops','plan']},
 {id:'project',icon:'▱',label:'Project & bundle',views:['project']}
];
function groupFor(view){return groups.find(g=>g.views.includes(view))||groups[0];}
function summarize(s){
 const stages=[
 {view:'inventory',title:'Discover source',scope:'Inventory',status:s.demo?'Illustrative demo':'Snapshot imported',detail:s.resources+' resources · '+s.findings+' open findings'},
 {view:'compare',title:'Review destination',scope:'Inventory',status:s.hasTarget?'Snapshot imported':'Not supplied',detail:'Snapshot presence does not verify destination compatibility.'},
 {view:'pilot',title:'Prepare selected pilot',scope:'Selected pilot',status:!s.pilot?'Not selected':s.pilot.blockers.length?'Draft blocked':'Draft requires validation',detail:!s.pilot?'Select a Deployment to establish validation scope.':s.pilot.blockers.length+' transformation blockers · '+s.pilot.prerequisites.length+' unverified prerequisites'},
 {view:'target',title:'Run target preflight',scope:'Selected pilot',status:!s.pilot?'Scope not selected':!s.hasPreflight?'Not run':s.preflight.unresolved?'Reported checks unresolved':'Reported checks complete',detail:s.pilot?s.preflight.reportedPass+' of '+s.preflight.total+' reported pass; runtime behavior remains unverified.':'Choose a pilot before collecting target observations.'},
 {view:'security',title:'Review control evidence',scope:'Inventory',status:s.security.total?s.security.unresolved?'Evidence unresolved':'Reported cases complete':'Coverage review required',detail:s.security.reportedComplete+' of '+s.security.total+' observed controls have complete reported cases. Independent review remains open.'},
 {view:'acceptance',title:'Review application acceptance',scope:'Selected pilot',status:s.acceptance?.unresolved===0?'Reported cases complete':'Evidence unresolved',detail:(s.acceptance?.reportedComplete||0)+' of '+(s.acceptance?.total||6)+' cases have reported source/target matches; independent acceptance remains open.'},
 {view:'project',title:'Review & hand off',scope:'Project',status:'Production gate closed',detail:'Application acceptance, data recovery, coverage and owner approval remain external gates.'}
 ];
 if(s.pilotLifecycle)stages.splice(5,0,{view:'pilot',title:'Run and observe pilot',scope:'Selected pilot',status:s.pilotLifecycle.status,detail:s.pilotLifecycle.detail});
 let next;
 if(s.demo)next={view:'inventory',action:'Import source inventory',reason:'The current workspace uses illustrative resources.',importSource:true};
 else if(!s.hasTarget)next={view:'compare',action:'Import destination inventory',reason:'Supply target evidence before reviewing destination mappings.'};
 else if(!s.pilot)next={view:'pilot',action:'Choose a pilot Deployment',reason:'Select a workload to define the draft and target-check scope.'};
 else if(s.pilotLifecycle?.recoveryRequired)next={view:'pilot',action:'Review pilot observations and recovery',reason:'The latest linked runtime/recovery record is unresolved. Review the existing run before further operations.'};
 else if(s.pilot.blockers.length)next={view:'pilot',action:'Resolve pilot draft blockers',reason:s.pilot.blockers.length+' transformation blockers prevent validation.'};
 else if(!s.hasPreflight||s.preflight.unresolved)next={view:'target',action:'Collect target preflight observations',reason:'Review the scoped plan, run the local checks and import their results.'};
 else if(!s.security.total||s.security.unresolved)next={view:'security',action:'Review security controls and coverage',reason:'Observed controls and source/target behavior need evidence and independent review.'};
 else if(s.pilotLifecycle?.requiresPilotRun)next={view:'pilot',action:'Validate and run the scoped pilot',reason:'Review execution blockers and prerequisites, then use the separately invoked local package.'};
 else if(!s.acceptance||s.acceptance.unresolved)next={view:'acceptance',action:'Review application acceptance cases',reason:'Define measurable behavior and review source/target observations for the selected pilot.'};
 else next={view:'plan',action:'Review remaining acceptance gates',reason:'Reported checks cannot establish application correctness or authorize production cutover.'};
 return {productionReady:false,gate:'Closed',next,stages,pilotLifecycle:s.pilotLifecycle||null,inventory:{resources:s.resources,openFindings:s.findings,blockers:s.blockers},pilot:s.pilot?{workload:s.pilot.workload,blockers:s.pilot.blockers.length,unverifiedPrerequisites:s.pilot.prerequisites.length}:null,note:'Derived from current workspace settings. External results are reported observations, never production approval.'};
}
root.MigrationJourney={groups,groupFor,summarize};if(typeof module!=='undefined')module.exports=root.MigrationJourney;
})(typeof window!=='undefined'?window:globalThis);
