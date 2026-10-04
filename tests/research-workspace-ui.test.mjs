import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const require=createRequire(new URL('../package.json',import.meta.url));
const ts=require('typescript'),React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
const leadId='10000000-0000-4000-8000-000000000001',jobId='20000000-0000-4000-8000-000000000001',runId='30000000-0000-4000-8000-000000000001',orgId='40000000-0000-4000-8000-000000000001';
const job=(patch={})=>({id:jobId,lead_id:leadId,organization_id:orgId,job_type:'LEAD_RESEARCH',strategy:'EMPRESARIO',status:'RUNNING',updated_at:'2026-10-04T12:00:00Z',progress:{research_run_id:runId,message:'Consultando cadastro empresarial.'},...patch});
const run=(patch={})=>({id:runId,lead_id:leadId,organization_id:orgId,status:'RUNNING',research_steps:[{id:'step-a',step_order:1,title:'Cadastro empresarial',status:'RUNNING',result_summary:'Consulta iniciada.'},{id:'step-b',step_order:2,title:'Contratos públicos',status:'PENDING'}],...patch});
const dossier=(patch={})=>({ok:true,role:'OWNER',lead:{id:leadId,organization_id:orgId,name:'Empresa QA',kind:'COMPANY',segment:'Indústria',initial_cnpj:null,identity_status:'PENDING'},research_runs:[],candidates:[],evidence:[],...patch});
function compile(relative,customRequire,extra=''){
 const source=fs.readFileSync(new URL(relative,import.meta.url),'utf8');
 const output=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}});
 const module={exports:{}};vm.runInNewContext(output.outputText+extra,{module,exports:module.exports,require:customRequire,URL,URLSearchParams,Date,Set,Map,console,window:{prompt:()=> 'Pista incorreta na revisão QA.'},setTimeout:customRequire.timers?.setTimeout||setTimeout,clearTimeout:customRequire.timers?.clearTimeout||clearTimeout});return module.exports;
}
const helper=compile('../lib/research-progress.ts',require),workspace=compile('../components/ResearchWorkspace.tsx',id=>id==='@/lib/research-progress'?helper:require(id));
function uiFixture({page='dossier',query='',initialDossier=dossier(),initialJobs=[],responder}={}){
 const hooks=[],effects=[],timers=new Map(),calls=[],routes=[],components={};let pointer=0,dirty=true,tree,currentQuery=query,disposed=false,timeoutId=0;
 let payload=initialDossier,jobs=initialJobs,insertions=0;
 const same=(a,b)=>!!a&&!!b&&a.length===b.length&&a.every((v,i)=>Object.is(v,b[i]));
 const hooksApi={
  useState(initial){const id=pointer++;if(!hooks[id])hooks[id]={value:typeof initial==='function'?initial():initial};return[hooks[id].value,next=>{if(disposed)return;const value=typeof next==='function'?next(hooks[id].value):next;if(!Object.is(value,hooks[id].value)){hooks[id].value=value;dirty=true}}]},
  useRef(initial){const id=pointer++;if(!hooks[id])hooks[id]={value:{current:initial}};return hooks[id].value},
  useMemo(callback,deps){const id=pointer++;if(!hooks[id]||!same(hooks[id].deps,deps))hooks[id]={value:callback(),deps};return hooks[id].value},
  useCallback(callback,deps){return hooksApi.useMemo(()=>callback,deps)},
  useEffect(callback,deps){const id=pointer++;if(!hooks[id]||!same(hooks[id].deps,deps)){const previous=hooks[id];hooks[id]={deps,cleanup:previous?.cleanup};effects.push(()=>{previous?.cleanup?.();hooks[id].cleanup=callback()})}},
  Suspense:React.Suspense,
 };
 const router={replace(url){routes.push(url);currentQuery=url.split('?')[1]||'';dirty=true},push(url){routes.push(url)}};
 const invoke=async(name,args)=>{calls.push({name,body:args.body});if(responder){const answer=await responder(name,args.body,calls.length);if(answer!==undefined)return answer}return name==='get-dossier'?{data:payload,error:null}:name==='research-queue'&&args.body.action==='list'?{data:{ok:true,jobs},error:null}:name==='research-queue'?{data:{ok:true,created:[job({status:'PENDING',progress:{stage:'QUEUED'}})],existing:[]},error:null}:{data:{ok:true},error:null}};
 const sb={functions:{invoke},from(){return{
  select(){return{order:async()=>({data:[],error:null})}},
  insert(){insertions++;return{select(){return{single:async()=>({data:{id:leadId},error:null})}}}},
 }}};
 const customRequire=id=>{
  if(id==='react')return hooksApi;
  if(id==='next/navigation')return{useParams:()=>({id:leadId}),useSearchParams:()=>new URLSearchParams(currentQuery),useRouter:()=>router};
  if(id==='@/lib/supabase')return{supabaseBrowser:()=>sb};
  if(id==='@/lib/research-progress')return helper;
  if(id==='@/lib/cnpj')return{normalizeCnpj:value=>String(value||'').replace(/\W/g,''),isValidCnpj:()=>true};
  if(id==='@/components/ResearchWorkspace')return workspace;
  if(id==='next/link')return props=>React.createElement('a',props,props.children);
  if(id==='xlsx')return{};
  if(id.startsWith('@/components/')){const name=id.split('/').at(-1);if(!components[name])components[name]=props=>React.createElement('div',{'data-component':name},props.children);return{[name]:components[name]}}
  return require(id);
 };
 customRequire.timers={setTimeout(callback,delay){const id=++timeoutId;timers.set(id,{callback,delay});return id},clearTimeout(id){timers.delete(id)}};
 const module=compile(page==='dossier'?'../app/leads/[id]/page.tsx':'../app/leads/page.tsx',customRequire,page==='dossier'?'\nexports.__content=LeadDossierContent;':'');
 const render=()=>{pointer=0;dirty=false;tree=(page==='dossier'?module.__content:module.default)();while(effects.length)effects.shift()();return tree};
 const f={calls,routes,timers,components,get tree(){return tree},get insertions(){return insertions},get dirty(){return dirty},render,html:()=>renderToStaticMarkup(tree),setDossier(value){payload=value},setJobs(value){jobs=value},async settle(){for(let i=0;i<30;i++){if(dirty)render();await new Promise(resolve=>setImmediate(resolve));if(!dirty&&i>5)break}},async tick(){const entry=timers.entries().next().value;if(entry){timers.delete(entry[0]);entry[1].callback()}await f.settle()},dispose(){disposed=true;for(const hook of hooks)hook?.cleanup?.();timers.clear()}};
 render();return f;
}
function find(tree,predicate){if(!tree||typeof tree!=='object')return null;if(predicate(tree))return tree;for(const child of [tree.props?.children].flat(Infinity)){const value=find(child,predicate);if(value)return value}return null}
const button=(tree,label)=>find(tree,node=>node.type==='button'&&node.props.children===label);
const researchPanel=tree=>find(tree,node=>node.type===workspace.ResearchWorkspace);
const enqueues=f=>f.calls.filter(call=>call.name==='research-queue'&&call.body.action==='enqueue');

await test('Primary Nova pesquisa immediately enqueues once and opens visual mode without family expansion',async()=>{
 let release;const pending=new Promise(resolve=>release=resolve);
 const f=uiFixture({responder:(name,body)=>name==='research-queue'&&body.action==='enqueue'?pending:undefined});await f.settle();
 const start=button(f.tree,'Nova pesquisa');assert.ok(start);const first=start.props.onClick();start.props.onClick();assert.equal(enqueues(f).length,1);
 release({data:{ok:true,created:[job({status:'PENDING',progress:{stage:'QUEUED'}})],existing:[]},error:null});await first;await f.settle();
 assert.ok(researchPanel(f.tree));assert.match(f.routes.at(-1),/mode=research&job=/);assert.equal(find(f.tree,node=>node.type===f.components.FamilyNetworkGraph),null);assert.equal(f.html().includes('Fatos documentados'),false);f.dispose();
});
await test('Fast COMPLETED query opens linked fresh PARTIAL results automatically, including company-name candidates',async()=>{
 const candidate={id:'candidate',candidate_type:'RFB_COMPANY_NAME_MATCH',label:'Empresa QA',validation_status:'UNVALIDATED',confidence:'LOW',candidate_reason:'Coincidência empresarial.',metadata:{company_name:'Empresa QA SA',trade_name:'Marca QA',full_cnpj:'12345678000195'}};
 const f=uiFixture({query:`mode=research&job=${jobId}`,initialJobs:[job({status:'COMPLETED',progress:{research_run_id:runId,research_status:'PARTIAL'}})],initialDossier:dossier({research_runs:[run({status:'PARTIAL',research_steps:[{id:'step-a',step_order:1,title:'Contratos',status:'BLOCKED'}]})],candidates:[candidate]})});await f.settle();
 assert.equal(researchPanel(f.tree),null);assert.match(f.html(),/Pesquisa finalizada com cobertura parcial/);assert.match(f.html(),/Próximo passo: confirme a empresa correta/);assert.match(f.html(),/Marca QA/);assert.equal(f.html().includes('Nome no QSA'),false);assert.equal(f.routes.at(-1),`/leads/${leadId}`);assert.equal(enqueues(f).length,0);f.dispose();
});
await test('Discarding a company-name candidate reports an independent review without claiming identity recalculation',async()=>{
 const candidate={id:'candidate',candidate_type:'RFB_COMPANY_NAME_MATCH',label:'Empresa QA',validation_status:'UNVALIDATED',confidence:'LOW',metadata:{full_cnpj:'12345678000195'}};
 const f=uiFixture({initialDossier:dossier({candidates:[candidate]})});await f.settle();const list=find(f.tree,node=>node.type?.name==='CandidateList');assert.ok(list);await list.props.onReject(candidate.id);await f.settle();assert.match(f.html(),/Pista empresarial descartada/);assert.equal(f.html().includes('identidade recalculada'),false);const review=f.calls.find(call=>call.name==='review-identity-candidate');assert.equal(review.body.action,'REJECT');assert.equal(review.body.candidate_id,candidate.id);f.dispose();
});
await test('An unrelated old completed run never closes an active or unlinked execution',async()=>{
 const f=uiFixture({query:`mode=research&job=${jobId}`,initialJobs:[job({status:'COMPLETED',progress:{}})],initialDossier:dossier({research_runs:[run({status:'COMPLETED'})]})});await f.settle();assert.ok(researchPanel(f.tree));assert.equal(researchPanel(f.tree).props.run,null);assert.equal(f.routes.length,0);assert.equal(enqueues(f).length,0);f.dispose();
});
await test('Starting again after completion does not show the previous execution as new progress',async()=>{
 let release;const pending=new Promise(resolve=>release=resolve);
 const f=uiFixture({query:`mode=research&job=${jobId}`,initialJobs:[job({status:'COMPLETED'})],initialDossier:dossier({research_runs:[run({status:'COMPLETED'})]}),responder:(name,body)=>name==='research-queue'&&body.action==='enqueue'?pending:undefined});await f.settle();button(f.tree,'Nova pesquisa').props.onClick();await f.settle();assert.ok(researchPanel(f.tree));assert.equal(researchPanel(f.tree).props.run,null);assert.equal(f.html().includes('Cadastro empresarial'),false);release({error:{message:'Temporarily unavailable'},data:null});await f.settle();f.dispose();
});
await test('Reload resumes actual scoped job and steps with zero automatic enqueue',async()=>{
 const f=uiFixture({query:`mode=research&job=${jobId}`,initialJobs:[job()],initialDossier:dossier({research_runs:[run()]})});await f.settle();assert.ok(researchPanel(f.tree));assert.match(f.html(),/Cadastro empresarial/);assert.match(f.html(),/1 de 2|0 de 2/);assert.equal(enqueues(f).length,0);assert.equal(f.calls.filter(call=>call.name==='research-queue'&&call.body.action==='list').every(call=>call.body.job_id===jobId),true);f.render();await f.settle();assert.equal(enqueues(f).length,0);f.dispose();
});
await test('Transient refresh failures retain real job and steps and expose connection error',async()=>{
 let fail=false;const f=uiFixture({query:`mode=research&job=${jobId}`,initialJobs:[job()],initialDossier:dossier({research_runs:[run()]}),responder:name=>fail&&name==='get-dossier'?{error:{message:'Conexão indisponível'},data:null}:undefined});await f.settle();fail=true;await f.tick();assert.equal(researchPanel(f.tree).props.job.id,jobId);assert.equal(researchPanel(f.tree).props.run.id,runId);assert.match(f.html(),/Conexão indisponível/);assert.match(f.html(),/último estado conhecido/);assert.equal(f.routes.length,0);f.dispose();
});
await test('Repeated refresh requests share one in-flight dossier/queue fetch',async()=>{
 let delay=false,release;const pending=new Promise(resolve=>release=resolve);
 const f=uiFixture({query:`mode=research&job=${jobId}`,initialJobs:[job()],initialDossier:dossier({research_runs:[run()]}),responder:name=>delay&&name==='get-dossier'?pending:undefined});await f.settle();delay=true;const before=f.calls.filter(call=>call.name==='get-dossier').length;researchPanel(f.tree).props.onRefresh();researchPanel(f.tree).props.onRefresh();await f.settle();assert.equal(f.calls.filter(call=>call.name==='get-dossier').length,before+1);release({data:dossier({research_runs:[run()]}),error:null});await f.settle();assert.equal(f.calls.filter(call=>call.name==='get-dossier').length,before+1);f.dispose();
});
await test('A response begun before enqueue cannot replace the newer execution',async()=>{
 const nextJobId='20000000-0000-4000-8000-000000000002',nextRunId='30000000-0000-4000-8000-000000000002';
 let hold=false,release,enqueued=false;const oldSnapshot=new Promise(resolve=>release=resolve);
 const f=uiFixture({initialDossier:dossier(),initialJobs:[],responder:(name,body)=>{
  if(name==='get-dossier'&&hold&&!enqueued)return oldSnapshot;
  if(name==='research-queue'&&body.action==='enqueue'){enqueued=true;return{data:{ok:true,created:[job({id:nextJobId,status:'PENDING',progress:{stage:'QUEUED'}})],existing:[]},error:null}}
  if(enqueued&&name==='get-dossier')return{data:dossier({research_runs:[run({id:nextRunId})]}),error:null};
  if(enqueued&&name==='research-queue'&&body.action==='list')return{data:{ok:true,jobs:[job({id:nextJobId,progress:{research_run_id:nextRunId}})]},error:null};
 }});await f.settle();hold=true;button(f.tree,'Configurar pesquisa').props.onClick();await f.settle();researchPanel(f.tree).props.onRefresh();await f.settle();const start=button(f.tree,'Nova pesquisa');start.props.onClick();await f.settle();release({data:dossier({research_runs:[run({status:'COMPLETED'})]}),error:null});await f.settle();assert.equal(researchPanel(f.tree).props.job.id,nextJobId);assert.equal(researchPanel(f.tree).props.run.id,nextRunId);assert.equal(f.html().includes('Pesquisa finalizada.'),false);assert.equal(enqueues(f).length,1);f.dispose();
});
await test('A failed enqueue keeps the saved lead in research mode with an explicit retry',async()=>{
 const f=uiFixture({responder:(name,body)=>name==='research-queue'&&body.action==='enqueue'?{data:{ok:false,error:'Fila indisponível'},error:null}:undefined});await f.settle();await button(f.tree,'Nova pesquisa').props.onClick();await f.settle();assert.ok(researchPanel(f.tree));assert.match(f.html(),/Fila indisponível/);assert.match(f.html(),/Iniciar pesquisa/);assert.equal(f.insertions,0);assert.match(f.routes.at(-1),/mode=research&issue=enqueue/);f.dispose();
});
await test('Viewer primary action is disabled and the handler also rejects enqueue',async()=>{
 const f=uiFixture({initialDossier:dossier({role:'VIEWER'})});await f.settle();const start=button(f.tree,'Nova pesquisa');assert.equal(start.props.disabled,true);await start.props.onClick();assert.equal(enqueues(f).length,0);f.dispose();
});
await test('New lead creation carries confirmed job id; double submission does not duplicate lead or job',async()=>{
 const f=uiFixture({page:'leads'});const name=find(f.tree,node=>node.type==='input'&&node.props.placeholder==='Pessoa ou empresa');name.props.onChange({target:{value:'Empresa QA'}});f.render();const form=find(f.tree,node=>node.type==='form'),event={preventDefault(){}};const first=form.props.onSubmit(event);form.props.onSubmit(event);await first;await f.settle();assert.equal(f.insertions,1);assert.equal(enqueues(f).length,1);assert.match(f.routes.at(-1),/mode=research&job=/);f.dispose();
});
await test('Creation queue failure navigates to retry on the same saved lead without falsely claiming start',async()=>{
 const f=uiFixture({page:'leads',responder:(name,body)=>name==='research-queue'&&body.action==='enqueue'?{error:{message:'Unavailable'},data:null}:undefined});find(f.tree,node=>node.type==='input'&&node.props.placeholder==='Pessoa ou empresa').props.onChange({target:{value:'Empresa QA'}});f.render();await find(f.tree,node=>node.type==='form').props.onSubmit({preventDefault(){}});await f.settle();assert.equal(f.insertions,1);assert.equal(f.routes.at(-1),`/leads/${leadId}?mode=research&issue=enqueue`);assert.equal(f.html().includes('A investigação foi colocada na fila'),false);f.dispose();
});
await test('Empty new lead name reports why research did not start',async()=>{const f=uiFixture({page:'leads'});await find(f.tree,node=>node.type==='form').props.onSubmit({preventDefault(){}});await f.settle();assert.match(f.html(),/Informe o nome/);assert.equal(f.insertions,0);assert.equal(enqueues(f).length,0);f.dispose()});
test('Failed or partial terminal phases and unsafe URLs never appear as successful coverage',()=>{
 const html=renderToStaticMarkup(React.createElement(workspace.ResearchWorkspace,{leadName:'QA',job:job({status:'FAILED'}),run:run({status:'FAILED',research_steps:[{id:'step',step_order:1,title:'Fonte',status:'FAILED',action_url:'javascript:alert(1)'}]}),hasJobId:true,starting:false,readOnly:false,error:'',configuration:null,onStart(){},onRefresh(){},onDismiss(){}}));assert.match(html,/research-phase issue/);assert.match(html,/Tentar nova pesquisa/);assert.equal(html.includes('href="javascript:'),false);assert.equal(html.includes('inteligência completa'),false);
});
