import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {resolveCompanyCnpj} from '../supabase/functions/_shared/company-context.ts';
import {buildSourceRoutes,runIndependent} from '../supabase/functions/_shared/source-router.ts';
import {ensureCompanyResearchLink,persistCompanyIdentitySupport} from '../supabase/functions/_shared/company-research-link.ts';

const USER='11111111-1111-4111-8111-111111111111',ORG='22222222-2222-4222-8222-222222222222',LEAD='33333333-3333-4333-8333-333333333333',JOB='44444444-4444-4444-8444-444444444444',RUN='55555555-5555-4555-8555-555555555555';
function install(endpoint,db,fetcher,env={}){
 let handler;const source=fs.readFileSync(new URL(`../supabase/functions/${endpoint}/index.ts`,import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'');
 vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText,{Deno:{env:{get:k=>k==='BRAVE_SEARCH_API_KEY'||k==='PORTAL_TRANSPARENCIA_API_TOKEN'?undefined:env[k]||'https://qa.supabase.co'},serve:fn=>{handler=fn}},createClient:()=>db,resolveCompanyCnpj,buildSourceRoutes,runIndependent,ensureCompanyResearchLink,persistCompanyIdentitySupport,fetch:fetcher,Request,Response,AbortSignal,console,EdgeRuntime:{waitUntil:()=>{}}});
 return body=>handler(new Request('https://qa.test',{method:'POST',headers:{Authorization:'Bearer synthetic','Content-Type':'application/json'},body:JSON.stringify(body)}));
}
function query(dbRead){return table=>{let mode='read',payload,columns;const eq={},within={},q={};for(const name of ['single','maybeSingle','order','limit','lte','neq'])q[name]=()=>q;q.select=(v)=>{columns=v;return q};q.eq=(k,v)=>{eq[k]=v;return q};q.in=(k,v)=>{within[k]=v;return q};for(const name of ['insert','update'])q[name]=p=>{mode=name;payload=p;return q};q.then=(resolve,reject)=>Promise.resolve(dbRead({table,mode,payload,columns,eq,within})).then(resolve,reject);return q}}
const session={getUser:async()=>({data:{user:{id:USER}}})};

function queueFixture(overrides={}){
 const state={role:'OWNER',initial:'32901144000105',...overrides},reads=[],writes=[],calls=[];
 const db={auth:session,from:query(r=>{(r.mode==='read'?reads:writes).push(r);let data=r.table==='profiles'?{active_organization_id:ORG}:r.table==='organization_members'?{status:'ACTIVE',role:state.role}:r.table==='leads'?[{id:LEAD,kind:'COMPANY',segment:'Agro',initial_cnpj:state.initial}]:r.table==='lead_company_links'?[]:r.table==='research_job_queue'?r.mode==='insert'?{id:JOB,lead_id:LEAD,organization_id:ORG,...JSON.parse(JSON.stringify(r.payload))}:r.columns?.includes('companies')?[]:state.active?{id:JOB,lead_id:LEAD,organization_id:ORG,job_type:'LEAD_RESEARCH',status:'RUNNING',strategy:'AGRO'}:null:null;return {data,error:null}})};
 const request=install('research-queue',db,async(url,init)=>{calls.push({url,body:init.body});return Response.json({ok:true})});return {state,reads,writes,calls,request};
}

test('fila mantém CNPJ validado e campos canônicos; payload livre não persiste token nem altera o contexto',async()=>{
 const f=queueFixture(),r=await f.request({action:'enqueue',lead_id:LEAD,payload:{cnpj:'84429695000111',objective:'FORGED',source:'FORGED',user_token:'PRIVATE_TOKEN',research_job_id:'FORGED'}});assert.equal(r.status,200);const job=f.writes.find(x=>x.table==='research_job_queue'&&x.mode==='insert').payload;assert.equal(job.payload.cnpj,'32901144000105');assert.equal(job.payload.source,'research_queue');assert.notEqual(job.payload.objective,'FORGED');assert.doesNotMatch(JSON.stringify(job),/PRIVATE_TOKEN|FORGED/);assert.equal(job.requested_by,USER);assert.equal(job.organization_id,ORG);assert.equal(f.calls.length,1);
});

test('retomada lê job_id exato dentro da organização e não transforma leitura em nova pesquisa',async()=>{
 const f=queueFixture();assert.equal((await f.request({action:'list',lead_id:LEAD,job_id:JOB})).status,200);const read=f.reads.find(r=>r.table==='research_job_queue');assert.deepEqual(read.eq,{organization_id:ORG,lead_id:LEAD,id:JOB});assert.equal(f.writes.length,0);assert.equal(f.calls.length,0);assert.equal((await f.request({action:'list',job_id:'invalid'})).status,400);
 for(const role of ['VIEWER','UNKNOWN']){const blocked=queueFixture({role});assert.equal((await blocked.request({action:'enqueue',lead_id:LEAD})).status,403);assert.equal(blocked.writes.length,0)}
});

test('enfileirar novamente reutiliza o job ativo com identidade de lead/org/tipo completa',async()=>{
 const f=queueFixture({active:true}),r=await f.request({action:'enqueue',lead_id:LEAD});assert.equal(r.status,200);const body=await r.json();assert.equal(body.created.length,0);assert.equal(body.existing[0].id,JOB);assert.equal(body.existing[0].lead_id,LEAD);assert.equal(body.existing[0].organization_id,ORG);assert.equal(body.existing[0].job_type,'LEAD_RESEARCH');const active=f.reads.find(q=>q.table==='research_job_queue');for(const field of ['lead_id','organization_id','job_type'])assert.ok(active.columns.split(',').includes(field));assert.equal(f.writes.length,0);assert.equal(f.calls.length,0);
});

function startFixture(overrides={}){
 const state={role:'OWNER',jobFound:true,jobStatus:'RUNNING',jobType:'LEAD_RESEARCH',progressError:false,finalError:false,discoveryStatus:'COMPLETED',...overrides},steps=[],events=[],writes=[],lead={id:LEAD,organization_id:ORG,kind:'COMPANY',name:'Marca QA',city:'Barretos',state:'SP',segment:'Agro',initial_cnpj:null,identity_status:'PENDING'};
 const sources=['base_empresarial_rfb','brasilapi_cnpj','cvm','cvm_dfp','cvm_ipe','querido_diario','central_balancos_sped','bndes_financing','pncp','web_search','portal_transparencia'].map(key=>({key,name:key,connection_status:'CONNECTED_LIMITED'}));
 const db={auth:session,from:query(r=>{
  if(r.mode!=='read'){writes.push(r);events.push({kind:'write',...r});if(r.table==='research_steps'){if(r.mode==='insert')steps.push(...JSON.parse(JSON.stringify(r.payload)));else Object.assign(steps.find(s=>s.step_key===r.eq.step_key)||{},JSON.parse(JSON.stringify(r.payload)))}}
  const data=r.table==='profiles'?{active_organization_id:ORG}:r.table==='organization_members'?{status:'ACTIVE',role:state.role}:r.table==='leads'?lead:r.table==='lead_company_links'?[]:r.table==='source_registry'?sources:r.table==='research_runs'?{id:RUN}:r.table==='research_steps'?steps:r.table==='research_job_queue'?state.jobFound?{id:JOB,status:state.jobStatus,job_type:state.jobType}:null:[];
  const error=state.progressError&&r.table==='research_job_queue'&&r.mode==='update'||state.finalError&&r.table==='research_runs'&&r.mode==='update'&&r.payload.status==='PARTIAL'?{message:'Controlled persistence failure'}:null;
  return {data,error,count:0};
 })};
 const fetcher=async(url,init)=>{const fn=url.split('/').at(-1);events.push({kind:'fetch',fn,body:JSON.parse(init.body)});return Response.json(fn==='company-name-discovery'?{ok:true,status:state.discoveryStatus,complete:state.discoveryStatus==='COMPLETED',candidates:[{candidate_id:JOB,candidate_type:'RFB_COMPANY_NAME_MATCH',validation_status:'UNVALIDATED',metadata:{full_cnpj:'32901144000105'}}],search_lineage:{match_mode:'PREFIX'}}:fn==='derive-signals'?{signals:[]}:fn==='capture-intelligence'?{ok:true}:{status:'PARTIAL',mentions_found:0})};
 return {state,steps,events,writes,lead,request:install('start-research',db,fetcher)};
}

test('novo COMPANY sem CNPJ descobre empresas nas quatro estratégias sem nome de sócio ou atribuição automática',async()=>{
 for(const strategy of ['EMPRESARIO','AGRO','MEDICO','GENERICO']){
  const f=startFixture(),r=await f.request({lead_id:LEAD,strategy,research_job_id:JOB});assert.equal(r.status,200);const result=await r.json();assert.equal(result.status,'PARTIAL');assert.equal(result.company_id,null);
  const fetches=f.events.filter(e=>e.kind==='fetch');assert.equal(fetches.filter(e=>e.fn==='company-name-discovery').length,1);assert.ok(fetches.every(e=>!['name-company-discovery','cnpj-enrich','identity-resolution','family-cluster-discovery','family-network-discovery'].includes(e.fn)));
  const named=f.steps.find(s=>s.step_key==='name_discovery');assert.equal(named.status,'COMPLETED');assert.equal(named.metadata.candidate_type,'RFB_COMPANY_NAME_MATCH');assert.equal(named.metadata.confirmation_required,true);assert.match(named.result_summary,/Confirme o CNPJ/);assert.equal(named.metadata.source_route.key,'company_name_discovery');
  assert.equal(f.steps.find(s=>s.step_key==='cnpj_qsa').status,'BLOCKED');assert.equal(f.steps.find(s=>s.step_key==='surname_candidates').status,'SKIPPED');assert.equal(f.lead.initial_cnpj,null);assert.equal(f.lead.identity_status,'PENDING');assert.ok(f.writes.every(w=>!['leads','candidate_entities','identity_assessments','claims','relationships'].includes(w.table)));
 }
});

test('job→run é gravado antes de chamar qualquer fonte e sempre usa job/lead/org/requester RUNNING exatos',async()=>{
 const f=startFixture(),r=await f.request({lead_id:LEAD,strategy:'AGRO',research_job_id:JOB});assert.equal(r.status,200);
 const firstSource=f.events.findIndex(e=>e.kind==='fetch'),link=f.events.findIndex(e=>e.kind==='write'&&e.table==='research_job_queue');assert.ok(link>=0&&link<firstSource);const updates=f.writes.filter(w=>w.table==='research_job_queue');assert.ok(updates.length>3);for(const update of updates){assert.equal(update.payload.progress.research_run_id,RUN);assert.deepEqual(update.eq,{id:JOB,organization_id:ORG,lead_id:LEAD,requested_by:USER,status:'RUNNING'})}
 for(const opts of [{jobFound:false},{jobStatus:'PENDING'},{jobType:'COMPANY_RESEARCH'},{role:'UNKNOWN'}]){const blocked=startFixture(opts);assert.equal((await blocked.request({lead_id:LEAD,strategy:'AGRO',research_job_id:JOB})).status,opts.role?403:409);assert.equal(blocked.writes.length,0);assert.equal(blocked.events.filter(e=>e.kind==='fetch').length,0)}
 const fail=startFixture({progressError:true});assert.equal((await fail.request({lead_id:LEAD,strategy:'AGRO',research_job_id:JOB})).status,500);assert.equal(fail.events.filter(e=>e.kind==='fetch').length,0);assert.ok(fail.writes.some(w=>w.table==='research_runs'&&w.payload.status==='FAILED'));
});

test('falha para finalizar a execução não é reportada como pesquisa concluída',async()=>{
 const f=startFixture({finalError:true}),r=await f.request({lead_id:LEAD,strategy:'AGRO',research_job_id:JOB});assert.equal(r.status,500);assert.equal((await r.json()).research_run_id,RUN);assert.ok(f.writes.some(w=>w.table==='research_runs'&&w.payload.status==='FAILED'));
});

function workerFixture(overrides={}){
 const state={role:'OWNER',lostResponse:false,finalWriteError:false,...overrides},events=[],writes=[];
 const item={id:JOB,organization_id:ORG,lead_id:LEAD,requested_by:USER,job_type:'LEAD_RESEARCH',strategy:'AGRO',status:'PENDING',attempts:0,max_attempts:3,payload:{cnpj:null,objective:'QA'},progress:{stage:'QUEUED'}};
 const db={auth:session,from:query(r=>{
  let data=r.table==='profiles'?{active_organization_id:ORG}:r.table==='organization_members'?{status:'ACTIVE',role:state.role}:r.table==='research_job_queue'?item:null;
  if(r.table==='research_job_queue'&&r.mode==='update'){writes.push(r);events.push({kind:'write',...r});if(!state.finalWriteError||r.payload.status==='RUNNING')Object.assign(item,JSON.parse(JSON.stringify(r.payload)));else return {data:null,error:{message:'Controlled write failure'}}}
  return {data,error:null,count:0};
 })};
 const fetcher=async(url,init)=>{events.push({kind:'fetch',url,body:JSON.parse(init.body)});if(state.lostResponse){item.progress={stage:'name_discovery',research_run_id:RUN};throw Error('Controlled lost response')}return Response.json({ok:true,research_run_id:RUN,status:'PARTIAL',history_capture:{ok:true}})};
 return {state,item,events,writes,request:install('research-queue-worker',db,fetcher)};
}

test('worker passa o job real ao orquestrador e só encerra após persistir resultado do mesmo RUNNING',async()=>{
 const f=workerFixture(),r=await f.request({});assert.equal(r.status,200);assert.equal((await r.json()).status,'COMPLETED');const body=f.events.find(e=>e.kind==='fetch').body;assert.equal(body.research_job_id,JOB);assert.equal(body.lead_id,LEAD);assert.equal(f.item.progress.research_run_id,RUN);assert.equal(f.item.progress.research_status,'PARTIAL');const final=f.writes.at(-1);assert.deepEqual(final.eq,{id:JOB,organization_id:ORG,requested_by:USER,status:'RUNNING'});
 const fail=workerFixture({finalWriteError:true});assert.equal((await fail.request({})).status,500);assert.equal(fail.item.status,'RUNNING');
});

test('resposta perdida preserva o run já ligado no banco durante RETRY; papel inválido não inicia worker',async()=>{
 const f=workerFixture({lostResponse:true}),r=await f.request({});assert.equal(r.status,200);assert.equal(f.item.status,'RETRY');assert.equal(f.item.progress.research_run_id,RUN);assert.equal((await r.json()).research_run_id,RUN);
 for(const role of ['VIEWER','UNKNOWN']){const blocked=workerFixture({role});assert.equal((await blocked.request({})).status,403);assert.equal(blocked.events.length,0)}
});
