import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {nodeLeadId,normalizeCompanyId} from '../supabase/functions/_shared/company-context.ts';
const ID='11111111-1111-4111-8111-111111111111',ORG='22222222-2222-4222-8222-222222222222',ORIGIN='33333333-3333-4333-8333-333333333333',EVIDENCE='44444444-4444-4444-8444-444444444444',SOURCE='55555555-5555-4555-8555-555555555555';
function fixture(overrides={}){
 const state={role:'OWNER',user:{id:ID},candidateType:'FAMILY_CONTEXT_MATCH',candidateStatus:'UNVALIDATED',confidence:'LOW',kind:'COMPANY',originKind:'PERSON',evidenceStatus:'VERIFIED',claimCount:0,foreign:false,rpcReject:false,sourceMissing:false,originMissing:false,runMissing:false,queueFails:false,...overrides};
 const calls=[],writes=[],rpcCalls=[],queueCalls=[];
 const md={evidence_id:EVIDENCE,full_cnpj:'32901144000105',company_name:'Empresa QA',person_name:'Ana Santos',city:'Barretos',state:'SP',segment:'Saúde',kinship_confirmed:false,match_basis:'QSA_PERSON',...overrides.metadata};
 const candidate={id:ID,organization_id:ORG,lead_id:ORIGIN,research_run_id:state.withRun?SOURCE:null,candidate_type:state.candidateType,validation_status:state.candidateStatus,confidence:state.confidence,entity_type:state.kind,metadata:md};
 const db={auth:{getUser:async()=>({data:{user:state.user},error:null})},from(table){
  let operation='read';const equals={},query={};query.select=()=>query;query.single=()=>query;query.maybeSingle=()=>query;query.eq=(key,value)=>{equals[key]=value;return query};
  for(const action of ['insert','update','upsert'])query[action]=payload=>{operation=action;writes.push({table,action,payload});return query};
  query.then=(resolve,reject)=>Promise.resolve().then(()=>{
   calls.push({table,operation,equals});
   if(operation!=='read')throw new Error('Endpoint must not directly promote evidence, identity or relationships');
   let data=table==='profiles'?{active_organization_id:ORG}:table==='organization_members'?{status:'ACTIVE',role:state.role}:table==='candidate_entities'?state.foreign?null:candidate:table==='leads'?state.originMissing?null:{id:ORIGIN,kind:state.originKind}:table==='evidence'?{id:EVIDENCE,verification_status:state.evidenceStatus,source_registry_id:SOURCE}:table==='source_registry'?state.sourceMissing?null:{id:SOURCE}:table==='research_runs'?state.runMissing?null:{id:SOURCE}:null;
   return {data,count:table==='claims'?state.claimCount:null,error:null};
  }).then(resolve,reject);return query;
 },async rpc(name,args){
  rpcCalls.push({name,args:structuredClone(args)});
  if(state.rpcReject)return {data:null,error:{message:'Concurrent review rejected opening'}};
  if(name==='review_graph_candidate')return {data:{...candidate,validation_status:'REJECTED'},error:null};
  assert.equal(name,'open_family_candidate');
  const targetType=args.p_entity_type;
  return {data:{lead:{id:args.p_lead_id,organization_id:ORG,kind:targetType,name:targetType==='COMPANY'?md.company_name:md.person_name,initial_cnpj:targetType==='COMPANY'?md.full_cnpj:null,city:targetType==='COMPANY'?md.city:null,state:targetType==='COMPANY'?md.state:null,identity_status:'PENDING',identity_confirmed_by_user:false},reused:state.reused===true},error:null};
 }};
 const fetcher=async(url,options)=>{queueCalls.push({url,body:JSON.parse(options.body)});return Response.json(state.queueFails?{error:'Controlled queue failure'}:{ok:true,queued:1},{status:state.queueFails?502:200})};
 return {state,db,candidate,calls,writes,rpcCalls,queueCalls,fetcher};
}
function handlerFor(file,f){
 let handler;const source=fs.readFileSync(new URL('../supabase/functions/'+file+'/index.ts',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'');
 vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText,{Deno:{env:{get:()=> 'https://qa.supabase.co'},serve:fn=>{handler=fn}},createClient:()=>f.db,nodeLeadId,normalizeCompanyId,fetch:f.fetcher,fetchSourceJson:()=>{throw new Error('Family review must not resolve a QSA company')},normalizeBaseCompany:()=>null,validateQsaMapping:()=>false,persistSourceEvidence:()=>{throw new Error('No family evidence promotion')},Response,Request,AbortSignal,console});
 return handler;
}
const request=(body={},auth=true)=>new Request('https://qa.test',{method:'POST',headers:auth?{Authorization:'Bearer qa','Content-Type':'application/json'}:{'Content-Type':'application/json'},body:JSON.stringify({candidate_id:ID,...body})});

test('abertura familiar exige sessão, papel de escrita e candidato da própria organização antes de qualquer mutação',async()=>{
 for(const [options,auth,status] of [[{},false,401],[{user:null},true,401],[{role:'VIEWER'},true,403],[{role:'UNKNOWN'},true,403],[{foreign:true},true,404]]){
  const f=fixture(options),res=await handlerFor('open-family-candidate',f)(request({},auth));assert.equal(res.status,status);assert.equal(f.rpcCalls.length,0);assert.equal(f.queueCalls.length,0);assert.equal(f.writes.length,0);
 }
 const own=fixture();await handlerFor('open-family-candidate',own)(request());
 for(const call of own.calls.filter(c=>['candidate_entities','evidence','leads','claims'].includes(c.table)))assert.equal(call.equals.organization_id,ORG);
});

test('rejeição, parentesco confirmado, suporte revisado e metadados incompatíveis bloqueiam abertura sem criar núcleo',async()=>{
 for(const options of [{candidateStatus:'REJECTED'},{metadata:{kinship_confirmed:true}},{evidenceStatus:'REJECTED'},{sourceMissing:true},{metadata:{full_cnpj:'123'}},{kind:'PERSON',metadata:{match_basis:'COMPANY_NAME'}},{confidence:'HIGH'},{originKind:'COMPANY'}]){
  const f=fixture(options);assert.equal((await handlerFor('open-family-candidate',f)(request())).status,409);assert.equal(f.rpcCalls.length,0);assert.equal(f.queueCalls.length,0);assert.equal(f.writes.length,0);
 }
 for(const options of [{originMissing:true},{withRun:true,runMissing:true}]){
  const f=fixture(options);assert.equal((await handlerFor('open-family-candidate',f)(request())).status,404);assert.equal(f.rpcCalls.length,0);
 }
});

test('empresa candidata abre núcleo determinístico e enfileira a pesquisa normal sem confirmar parentesco ou identidade',async()=>{
 const f=fixture(),res=await handlerFor('open-family-candidate',f)(request());assert.equal(res.status,200);const data=await res.json();
 const expected=await nodeLeadId(ORG,'COMPANY','family-company:32901144000105');assert.equal(data.lead.id,expected);assert.equal(data.lead.identity_status,'PENDING');assert.equal(data.lead.identity_confirmed_by_user,false);assert.equal(data.kinship_confirmed,false);
 assert.deepEqual(f.rpcCalls[0],{name:'open_family_candidate',args:{p_org:ORG,p_user:ID,p_candidate:ID,p_entity_type:'COMPANY',p_lead_id:expected}});
 assert.deepEqual(f.queueCalls[0].body,{action:'enqueue',lead_id:expected});assert.match(f.queueCalls[0].url,/\/research-queue$/);assert.equal(f.candidate.validation_status,'UNVALIDATED');assert.equal(f.writes.length,0);
});

test('pessoa do QSA abre investigação independente sem copiar endereço da empresa ou atribuir CNPJ à pessoa',async()=>{
 const f=fixture({kind:'PERSON'}),data=await (await handlerFor('open-family-candidate',f)(request({entity_type:'PERSON'}))).json();
 assert.equal(data.lead.id,await nodeLeadId(ORG,'PERSON','family-person:'+ID));assert.equal(data.lead.name,'Ana Santos');assert.equal(data.lead.initial_cnpj,null);assert.equal(data.lead.city,null);assert.equal(data.lead.state,null);assert.equal(data.lead.identity_status,'PENDING');assert.equal(f.writes.length,0);
});

test('pista PERSON do QSA também abre a empresa documentada sem converter a pessoa em empresa',async()=>{
 const f=fixture({kind:'PERSON'}),res=await handlerFor('open-family-candidate',f)(request({entity_type:'COMPANY'}));assert.equal(res.status,200);const data=await res.json();
 assert.equal(data.lead.id,await nodeLeadId(ORG,'COMPANY','family-company:32901144000105'));assert.equal(data.lead.kind,'COMPANY');assert.equal(data.lead.name,'Empresa QA');assert.equal(data.lead.initial_cnpj,'32901144000105');assert.equal(data.lead.identity_status,'PENDING');assert.equal(data.kinship_confirmed,false);
 assert.equal(f.candidate.entity_type,'PERSON');assert.equal(f.candidate.validation_status,'UNVALIDATED');assert.equal(f.rpcCalls[0].args.p_entity_type,'COMPANY');assert.deepEqual(f.queueCalls[0].body,{action:'enqueue',lead_id:data.lead.id});assert.equal(f.writes.length,0);
 for(const options of [{kind:'PERSON',evidenceStatus:'REJECTED'},{kind:'PERSON',candidateStatus:'REJECTED'},{kind:'PERSON',metadata:{full_cnpj:'123'}}]){
  const blocked=fixture(options);assert.equal((await handlerFor('open-family-candidate',blocked)(request({entity_type:'COMPANY'}))).status,409);assert.equal(blocked.rpcCalls.length,0);assert.equal(blocked.queueCalls.length,0);
 }
 const wrong=fixture({kind:'COMPANY'});assert.equal((await handlerFor('open-family-candidate',wrong)(request({entity_type:'PERSON'}))).status,409);assert.equal(wrong.rpcCalls.length,0);
});

test('reabertura com fatos existentes reutiliza núcleo sem nova fila e revisão concorrente prevalece na transação',async()=>{
 const reuse=fixture({claimCount:3,reused:true}),data=await (await handlerFor('open-family-candidate',reuse)(request())).json();assert.equal(data.reused,true);assert.equal(reuse.queueCalls.length,0);
 const rejected=fixture({rpcReject:true});assert.equal((await handlerFor('open-family-candidate',rejected)(request())).status,409);assert.equal(rejected.queueCalls.length,0);assert.equal(rejected.writes.length,0);
 const queue=fixture({queueFails:true}),partial=await (await handlerFor('open-family-candidate',queue)(request())).json();assert.equal(partial.ok,true);assert.equal(partial.research_error,'Controlled queue failure');assert.equal(partial.kinship_confirmed,false);
});

test('descarte familiar usa auditoria existente e RESOLVE é bloqueado antes de qualquer consulta externa',async()=>{
 const resolve=fixture();assert.equal((await handlerFor('review-graph-candidate',resolve)(request({action:'RESOLVE',reason:'Não confirmar parentesco'}))).status,409);assert.equal(resolve.rpcCalls.length,0);assert.equal(resolve.queueCalls.length,0);assert.equal(resolve.writes.length,0);
 const reject=fixture(),res=await handlerFor('review-graph-candidate',reject)(request({action:'REJECT',reason:'Homônimo sem relação comprovada'}));assert.equal(res.status,200);
 assert.deepEqual(reject.rpcCalls[0],{name:'review_graph_candidate',args:{p_org:ORG,p_user:ID,p_candidate:ID,p_action:'REJECT',p_reason:'Homônimo sem relação comprovada'}});assert.equal(reject.queueCalls.length,0);assert.equal(reject.writes.length,0);
 const viewer=fixture({role:'VIEWER'});assert.equal((await handlerFor('review-graph-candidate',viewer)(request({action:'REJECT',reason:'Descartar pista'}))).status,403);assert.equal(viewer.rpcCalls.length,0);
});
