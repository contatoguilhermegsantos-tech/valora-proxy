import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {assessIdentity} from '../supabase/functions/identity-resolution/policy.ts';
import {validQsaDiscoveryEvidence} from '../supabase/functions/_shared/qsa-evidence.ts';

const USER='11111111-1111-4111-8111-111111111111',ORG='22222222-2222-4222-8222-222222222222',LEAD='33333333-3333-4333-8333-333333333333',CAND='44444444-4444-4444-8444-444444444444',DOC='55555555-5555-4555-8555-555555555555',RUN='66666666-6666-4666-8666-666666666666',ASSESSMENT='77777777-7777-4777-8777-777777777777',SOURCE='88888888-8888-4888-8888-888888888888',OTHER='99999999-9999-4999-8999-999999999999',CNPJ='32901144000105';
const copy=v=>JSON.parse(JSON.stringify(v));
function candidate(id=CAND,doc=DOC){return{id,organization_id:ORG,lead_id:LEAD,candidate_type:'RFB_QSA_NAME_MATCH',entity_type:'COMPANY',label:'Empresa QA',validation_status:'UNVALIDATED',confidence:'LOW',metadata:{partner_name:'JOAO DA SILVA',full_cnpj:CNPJ,basic_cnpj:CNPJ.slice(0,8),company_name:'Empresa QA',city:'Barretos',state:'SP',evidence_id:doc}}}
function document(id=DOC){return{id,organization_id:ORG,lead_id:LEAD,source_registry_id:SOURCE,verification_status:'VERIFIED',document_type:'RFB_QSA_NAME_DISCOVERY',source_url:'https://baseempresarial.com.br/empresa/'+CNPJ,raw_reference:JSON.stringify({schema_version:2,partner_name:'JOAO DA SILVA',query_name:'JOAO DA SILVA',full_cnpj:CNPJ,basic_cnpj:CNPJ.slice(0,8),company_name:'Empresa QA'})}}
function fixture(overrides={}){
 let handler,leadReads=0;const reads=[],writes=[],events=[];
 const state={user:{id:USER},org:ORG,role:'OWNER',memberStatus:'ACTIVE',lead:{id:LEAD,organization_id:ORG,kind:'PERSON',name:'João da Silva',city:'Barretos',state:'SP',identity_status:'PENDING',identity_confirmed_by_user:false},run:{id:RUN,organization_id:ORG,lead_id:LEAD},candidates:[candidate()],documents:[document()],sources:[{id:SOURCE,key:'base_empresarial_rfb'}],fetchData:{ok:true,complete:true,candidates_found:1,groups:[],mentions_found:0,results_found:0},rpcError:null,...overrides};
 const db={auth:{getUser:async()=>({data:{user:state.user},error:state.authError||null})},from(table){let mode='read',payload;const filters=[];const q={};for(const m of ['select','single','maybeSingle'])q[m]=()=>q;for(const m of ['eq','neq','in'])q[m]=(key,value)=>{filters.push([m,key,value]);return q};for(const m of ['insert','update','upsert'])q[m]=value=>{mode=m;payload=value;return q};
  q.then=(resolve,reject)=>Promise.resolve().then(()=>{
   (mode==='read'?reads:writes).push(copy({table,mode,payload:payload??null,filters}));
   if(mode!=='read')return{data:state.emptyWrite?null:{id:ASSESSMENT},error:state.writeError===table?{message:'PRIVATE_DATABASE_WRITE'}:null};
   let data=table==='profiles'?{active_organization_id:state.org}:table==='organization_members'?{role:state.role,status:state.memberStatus}:table==='research_runs'?state.run:table==='candidate_entities'?state.candidates:table==='evidence'?state.documents:table==='source_registry'?state.sources:table==='leads'?(leadReads++>0?state.freshLead||state.lead:state.lead):null;
   const matches=row=>filters.every(([op,key,val])=>op==='eq'?row[key]===val:op==='neq'?row[key]!==val:val.includes(row[key]));
   if(Array.isArray(data))data=data.filter(matches);else if(data&&!['profiles','organization_members'].includes(table)&&!matches(data))data=null;
   return{data:copy(data),error:state.readError===table||table==='leads'&&leadReads>1&&state.freshReadError?{message:'PRIVATE_DATABASE_READ'}:null};
  }).then(resolve,reject);return q;
 },rpc:async(name,args)=>{
  events.push({kind:'rpc',name,args:copy(args)});
  if(name==='refresh_qsa_identity_status')return{data:state.refreshData??{ok:true,lead_status:state.freshLead?.identity_status||state.lead?.identity_status||'PENDING'},error:state.refreshError||null};
  if(state.rpcError)return{data:null,error:state.rpcError};
  if(state.rpcResult)return{data:copy(state.rpcResult),error:null};
  const row=state.candidates.find(c=>c.id===args.p_candidate),validation_status=row?.validation_status==='CONFIRMED'?'CONFIRMED':args.p_decision==='SUPPORTED'?'SUPPORTED':'UNVALIDATED';
  return{data:{applied:true,assessment_id:ASSESSMENT,score:args.p_score,decision:args.p_decision,validation_status,lead_status:'CAUTION'},error:null};
 }};
 const source=fs.readFileSync(new URL('../supabase/functions/identity-resolution/index.ts',import.meta.url),'utf8').replace(/^\uFEFF/,'').replace(/^import .*;\r?\n/gm,'');
 vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText,{Deno:{env:{get:()=> 'https://qa.supabase.co'},serve:fn=>handler=fn},createClient:()=>db,assessIdentity,validQsaDiscoveryEvidence,fetch:async(url,init)=>{events.push({kind:'fetch',url,body:JSON.parse(init.body)});if(state.fetchThrows)throw Error('PRIVATE_UPSTREAM_MESSAGE');return Response.json(state.fetchData,{status:state.fetchHttp||200})},Request,Response,AbortSignal,console});
 return{state,reads,writes,events,call:async(body={},auth=true)=>handler(new Request('https://qa.test',{method:'POST',headers:auth?{Authorization:'Bearer synthetic','Content-Type':'application/json'}:{'Content-Type':'application/json'},body:JSON.stringify({lead_id:LEAD,run_discovery:false,...body})}))};
}
const rpcs=f=>f.events.filter(e=>e.kind==='rpc'&&e.name==='assess_qsa_name_candidate');
const refreshes=f=>f.events.filter(e=>e.kind==='rpc'&&e.name==='refresh_qsa_identity_status');
const directIdentityWrites=f=>f.writes.filter(w=>['identity_assessments','candidate_entities','leads'].includes(w.table));

test('identity scoring requires an authenticated active operator and a person lead',async()=>{
 for(const [change,auth,status]of [[{},false,401],[{user:null},true,401],[{authError:{message:'PRIVATE_AUTH'}},true,401],[{org:null},true,409],[{role:'VIEWER'},true,403],[{role:'UNKNOWN'},true,403],[{memberStatus:'INACTIVE'},true,403],[{lead:null},true,404],[{lead:{id:LEAD,organization_id:ORG,kind:'COMPANY'}},true,409]]){const f=fixture(change);assert.equal((await f.call({},auth)).status,status);assert.equal(f.events.length,0);assert.equal(f.writes.length,0)}
 for(const role of ['OWNER','ADMIN','ANALYST','MEMBER']){const f=fixture({role});assert.equal((await f.call()).status,200)}
});
test('lead/run IDs and run organization/lead scope are checked before any source or write',async()=>{
 for(const body of [{lead_id:'invalid'},{research_run_id:'invalid'},{research_run_id:17},{research_run_id:''}]){const f=fixture();assert.equal((await f.call(body)).status,400);assert.equal(f.writes.length,0);assert.equal(f.events.length,0)}
 for(const run of [null,{id:RUN,organization_id:OTHER,lead_id:LEAD},{id:RUN,organization_id:ORG,lead_id:OTHER}]){const f=fixture({run});assert.equal((await f.call({research_run_id:RUN})).status,404);assert.equal(f.writes.length,0);assert.equal(f.events.length,0)}
 const f=fixture();assert.equal((await f.call({research_run_id:RUN})).status,200);assert.equal(rpcs(f)[0].args.p_run,RUN);assert.deepEqual(f.reads.find(r=>r.table==='research_runs').filters,[['eq','id',RUN],['eq','organization_id',ORG],['eq','lead_id',LEAD]]);
});
test('valid cited QSA evidence permits contextual support through one CAS RPC and no distributed identity writes',async()=>{
 const f=fixture({freshLead:{id:LEAD,organization_id:ORG,identity_status:'SUPPORTED',identity_confirmed_by_user:false}}),response=await f.call(),data=await response.json();
 assert.equal(response.status,200);assert.equal(data.lead_status,'SUPPORTED');assert.equal(data.candidates[0].score,75);assert.equal(data.candidates[0].decision,'SUPPORTED');assert.equal(data.candidates[0].factors.evidence_binding_valid,true);assert.equal(data.candidates[0].factors.ambiguous,false);
 assert.equal(rpcs(f).length,1);assert.equal(rpcs(f)[0].name,'assess_qsa_name_candidate');assert.deepEqual(rpcs(f)[0].args.p_expected_meta,f.state.candidates[0].metadata);assert.equal(rpcs(f)[0].args.p_expected_status,'UNVALIDATED');assert.equal(rpcs(f)[0].args.p_org,ORG);assert.equal(rpcs(f)[0].args.p_user,USER);assert.equal(directIdentityWrites(f).length,0);
 const bound=f.reads.find(r=>r.table==='evidence');assert.deepEqual(bound.filters,[['eq','organization_id',ORG],['eq','lead_id',LEAD],['in','id',[DOC]]]);
});
test('missing evidence binding cannot be repaired by a newer unrelated document or receive any score',async()=>{
 const f=fixture();delete f.state.candidates[0].metadata.evidence_id;const data=await(await f.call()).json();
 assert.equal(data.candidates[0].score,0);assert.equal(data.candidates[0].decision,'REVIEW');assert.equal(data.candidates[0].confidence,'LOW');assert.equal(data.candidates[0].factors.evidence_binding_valid,false);assert.equal(f.reads.some(r=>r.table==='evidence'),false);assert.equal(rpcs(f)[0].args.p_score,0);assert.equal(rpcs(f)[0].args.p_decision,'REVIEW');
});
test('reviewed, missing, foreign or tampered discovery documents yield REVIEW/0, including previously supported candidates',async()=>{
 const variants=[null,{verification_status:'PENDING'},{verification_status:'REJECTED'},{verification_status:'CONTRADICTED'},{organization_id:OTHER},{lead_id:OTHER},{document_type:'CNPJ_REGISTRY'},{source_registry_id:OTHER},{source_url:'https://baseempresarial.com.br/empresa/84429695000111'},{raw_reference:'malformed'},{raw_reference:JSON.stringify({...JSON.parse(document().raw_reference),full_cnpj:'84429695000111'})},{raw_reference:JSON.stringify({...JSON.parse(document().raw_reference),partner_name:'JOSE PEREIRA'})},{raw_reference:JSON.stringify({...JSON.parse(document().raw_reference),query_name:'JOSE PEREIRA'})},{raw_reference:JSON.stringify({...JSON.parse(document().raw_reference),company_name:'Outra empresa'})}];
 for(const change of variants){const f=fixture();f.state.candidates[0].validation_status='SUPPORTED';f.state.documents=change===null?[]:[{...document(),...change}];const response=await f.call(),data=await response.json();assert.equal(response.status,200);assert.equal(data.candidates[0].score,0);assert.equal(data.candidates[0].decision,'REVIEW');assert.equal(data.candidates[0].validation_status,'UNVALIDATED');assert.equal(data.candidates[0].factors.evidence_binding_valid,false);assert.equal(directIdentityWrites(f).length,0)}
 const f=fixture();f.state.sources[0].key='other_provider';assert.equal((await(await f.call()).json()).candidates[0].score,0);
});
test('changed current person name, exact CNPJ root or checksum invalidates scoring',async()=>{
 for(const alter of [f=>f.state.lead.name='José Pereira',f=>f.state.candidates[0].metadata.basic_cnpj='84429695',f=>f.state.candidates[0].metadata.full_cnpj='32901144000106']){const f=fixture();alter(f);const data=await(await f.call()).json();assert.equal(data.candidates[0].score,0);assert.equal(data.candidates[0].decision,'REVIEW')}
});
test('strict legacy reference only scores when the exact scoped evidence ID is bound',async()=>{const f=fixture();f.state.documents[0].raw_reference='partner_name=JOAO DA SILVA; basic_cnpj=32901144';assert.equal((await(await f.call()).json()).candidates[0].decision,'SUPPORTED');const other=fixture();other.state.documents[0].raw_reference='partner_name=JOAO DA SILVA; basic_cnpj=84429695';assert.equal((await(await other.call()).json()).candidates[0].score,0)});
test('invalid-document homonyms cannot make a valid current candidate ambiguous',async()=>{
 const f=fixture();f.state.candidates.push(candidate(OTHER,OTHER));const data=await(await f.call()).json();assert.equal(data.ambiguity,false);assert.equal(data.candidates.find(c=>c.candidate_id===CAND).decision,'SUPPORTED');assert.equal(data.candidates.find(c=>c.candidate_id===OTHER).score,0);
});
test('two current verified discovery documents retain the ambiguity gate without human confirmation',async()=>{const f=fixture();f.state.candidates.push(candidate(OTHER,OTHER));f.state.documents.push(document(OTHER));const data=await(await f.call()).json();assert.equal(data.ambiguity,true);assert.ok(data.candidates.every(c=>c.decision==='AMBIGUOUS'&&c.score===75));assert.ok(rpcs(f).every(r=>r.args.p_factors.ambiguous===true))});
test('historical human CONFIRMED remains CONFIRMED/100 with missing old discovery and keeps fresh VERIFIED status',async()=>{
 const f=fixture({documents:[],freshLead:{id:LEAD,organization_id:ORG,identity_status:'VERIFIED',identity_confirmed_by_user:true}});f.state.candidates[0].validation_status='CONFIRMED';delete f.state.candidates[0].metadata.evidence_id;const data=await(await f.call()).json();assert.equal(data.lead_status,'VERIFIED');assert.equal(data.candidates[0].score,100);assert.equal(data.candidates[0].decision,'CONFIRMED');assert.equal(data.candidates[0].validation_status,'CONFIRMED');assert.equal(data.candidates[0].factors.user_confirmed,true);assert.equal(data.candidates[0].factors.evidence_binding_valid,false);assert.equal(directIdentityWrites(f).length,0);
});
test('a rejection already present is excluded and a racing review/CAS miss produces no stale support response',async()=>{
 const rejected=fixture();rejected.state.candidates[0].validation_status='REJECTED';const empty=await(await rejected.call()).json();assert.equal(empty.candidates_assessed,0);assert.equal(rpcs(rejected).length,0);assert.equal(refreshes(rejected).length,1);
 for(const status of ['REJECTED','CONFIRMED','UNVALIDATED']){const f=fixture({rpcResult:{applied:false,validation_status:status,lead_status:'PENDING'},freshLead:{id:LEAD,organization_id:ORG,identity_status:status==='CONFIRMED'?'VERIFIED':'CAUTION',identity_confirmed_by_user:status==='CONFIRMED'}});const data=await(await f.call()).json();assert.equal(data.candidates_assessed,0);assert.equal(data.candidates.length,0);assert.equal(data.assessments_skipped[0].validation_status,status);assert.equal(data.lead_status,status==='CONFIRMED'?'VERIFIED':'CAUTION');assert.equal(directIdentityWrites(f).length,0)}
});
test('document reviewed between scoring and the transaction uses the effective REVIEW/0 returned by the RPC',async()=>{
 const f=fixture({rpcResult:{applied:true,assessment_id:ASSESSMENT,validation_status:'UNVALIDATED',score:0,decision:'REVIEW',lead_status:'CAUTION'},freshLead:{id:LEAD,organization_id:ORG,identity_status:'CAUTION',identity_confirmed_by_user:false}}),data=await(await f.call()).json();assert.equal(rpcs(f)[0].args.p_score,75);assert.equal(data.candidates[0].score,0);assert.equal(data.candidates[0].decision,'REVIEW');assert.equal(data.candidates[0].factors.evidence_binding_valid,false);assert.equal(data.candidates[0].confidence,'LOW');assert.equal(data.lead_status,'CAUTION');
});
test('database read/log failures are checked and private error details never escape',async()=>{
 for(const table of ['profiles','organization_members','leads','candidate_entities','evidence','source_registry','research_runs']){const f=fixture({readError:table}),response=await f.call({research_run_id:RUN});assert.equal(response.status,500);assert.equal(rpcs(f).length,0);assert.doesNotMatch(await response.text(),/PRIVATE_DATABASE/)}
 const f=fixture({writeError:'identity_source_attempts'}),response=await f.call();assert.equal(response.status,500);assert.equal(rpcs(f).length,0);assert.doesNotMatch(await response.text(),/PRIVATE_DATABASE/);
 const missing=fixture({emptyWrite:true});assert.equal((await missing.call()).status,500);assert.equal(rpcs(missing).length,0);
 const fresh=fixture({freshReadError:true});assert.equal((await fresh.call()).status,500);assert.equal(directIdentityWrites(fresh).length,0);
});
test('failed or malformed transactional results never fall back to distributed writes',async()=>{
 for(const [code,status]of [['42501',403],['P0002',404],['22023',400],['P0001',409],['57014',500]]){const f=fixture({rpcError:{code,message:'PRIVATE_RPC_FAILURE'}}),response=await f.call();assert.equal(response.status,status);assert.equal(rpcs(f).length,1);assert.equal(directIdentityWrites(f).length,0);assert.doesNotMatch(await response.text(),/PRIVATE_RPC_FAILURE/)}
 for(const result of [{},{applied:true,assessment_id:ASSESSMENT},{applied:true,assessment_id:'invalid',score:75,decision:'SUPPORTED'}]){const f=fixture({rpcResult:result});assert.equal((await f.call()).status,500);assert.equal(directIdentityWrites(f).length,0)}
});
test('failed discovery has safe diagnostics and cannot resurrect support from an unbound candidate',async()=>{
 const f=fixture({fetchThrows:true});delete f.state.candidates[0].metadata.evidence_id;const response=await f.call({run_discovery:true}),data=await response.json();assert.equal(response.status,200);assert.equal(data.source_attempts[0].status,'FAILED');assert.equal(data.source_attempts[0].metadata.error,'SOURCE_UNAVAILABLE');assert.equal(data.candidates[0].score,0);assert.doesNotMatch(JSON.stringify(data),/PRIVATE_UPSTREAM_MESSAGE/);
});
test('zero active candidates still refresh identity under the lead lock before reading current status',async()=>{
 const f=fixture({candidates:[],freshLead:{id:LEAD,organization_id:ORG,identity_status:'PENDING',identity_confirmed_by_user:false}});f.state.lead.identity_status='SUPPORTED';const data=await(await f.call()).json();assert.equal(data.lead_status,'PENDING');assert.equal(data.candidates_assessed,0);assert.equal(rpcs(f).length,0);assert.equal(refreshes(f).length,1);assert.deepEqual(refreshes(f)[0].args,{p_org:ORG,p_user:USER,p_lead:LEAD});assert.equal(directIdentityWrites(f).length,0);
});
test('final identity refresh failure is checked even with zero candidates and never falls back to endpoint writes',async()=>{
 for(const change of [{refreshError:{code:'P0001',message:'PRIVATE_REFRESH_FAILURE'}},{refreshData:{ok:false,lead_status:'SUPPORTED'}},{refreshData:{ok:true}},{refreshData:{}}]){const f=fixture({candidates:[],...change}),response=await f.call();assert.equal(response.status,500);assert.equal(refreshes(f).length,1);assert.equal(directIdentityWrites(f).length,0);assert.doesNotMatch(await response.text(),/PRIVATE_REFRESH_FAILURE/)}
});
