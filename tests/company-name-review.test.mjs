import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const USER='11111111-1111-4111-8111-111111111111',ORG='22222222-2222-4222-8222-222222222222',LEAD='33333333-3333-4333-8333-333333333333',CANDIDATE='44444444-4444-4444-8444-444444444444',DOC='55555555-5555-4555-8555-555555555555',COMPANY='66666666-6666-4666-8666-666666666666',REGISTRY='77777777-7777-4777-8777-777777777777',SOURCE='88888888-8888-4888-8888-888888888888',CNPJ='32901144000105';

function fixture(endpoint,overrides={}){
 const state={user:{id:USER},role:'OWNER',org:ORG,candidate:{id:CANDIDATE,organization_id:ORG,lead_id:LEAD,entity_type:'COMPANY',candidate_type:'RFB_COMPANY_NAME_MATCH',validation_status:'UNVALIDATED',metadata:{full_cnpj:CNPJ,evidence_id:DOC}},lead:{id:LEAD,kind:'COMPANY',initial_cnpj:null},document:{id:DOC,verification_status:'VERIFIED',source_registry_id:SOURCE,document_type:'CNPJ_REGISTRY',raw_reference:JSON.stringify({full_cnpj:CNPJ})},enrichment:{company_id:COMPANY,evidence_id:REGISTRY},rpcError:null,rpcData:{ok:true,candidate_id:CANDIDATE,lead_id:LEAD},...overrides};
 const reads=[],writes=[],events=[];let handler;
 const db={auth:{getUser:async()=>({data:{user:state.user}})},from(table){let mode='read',payload;const eq={};const q={select:()=>q,single:()=>q,maybeSingle:()=>q,eq:(k,v)=>{eq[k]=v;return q},update:p=>{mode='update';payload=p;return q},insert:p=>{mode='insert';payload=p;return q}};
  q.then=(resolve,reject)=>Promise.resolve().then(()=>{
   (mode==='read'?reads:writes).push({table,mode,payload,eq});
   const data=table==='profiles'?{active_organization_id:state.org}:table==='organization_members'?{status:'ACTIVE',role:state.role}:table==='candidate_entities'?state.candidate:table==='leads'?state.lead:table==='evidence'?state.document:null;
   return {data,error:state.documentError&&table==='evidence'?{message:'Controlled read failure'}:null};
  }).then(resolve,reject);return q;
 },rpc:async(name,args)=>{events.push({kind:'rpc',name,args:JSON.parse(JSON.stringify(args))});return {data:state.rpcData,error:state.rpcError}}};
 const fetcher=async(url,init)=>{events.push({kind:'fetch',url,body:JSON.parse(init.body),headers:init.headers});if(state.fetchThrows)throw Error('PRIVATE_UPSTREAM_MESSAGE');return Response.json(state.enrichment,{status:state.enrichmentHttp||200})};
 const source=fs.readFileSync(new URL(`../supabase/functions/${endpoint}/index.ts`,import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'');
 vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText,{Deno:{env:{get:()=> 'https://qa.supabase.co'},serve:fn=>{handler=fn}},createClient:()=>db,fetch:fetcher,Request,Response,AbortSignal,console});
 return {state,reads,writes,events,request:async(body={},auth=true)=>handler(new Request('https://qa.test',{method:'POST',headers:auth?{Authorization:'Bearer synthetic','Content-Type':'application/json'}:{'Content-Type':'application/json'},body:JSON.stringify({candidate_id:CANDIDATE,action:'REJECT',reason:'Entidade jurídica incorreta',...body})}))};
}

test('confirmação empresarial exige sessão, operador, candidato e lead no contexto autorizado',async()=>{
 for(const [options,auth,status] of [[{},false,401],[{user:null},true,401],[{role:'VIEWER'},true,403],[{role:'UNKNOWN'},true,403],[{org:null},true,409],[{candidate:null},true,404],[{lead:null},true,404],[{lead:{id:LEAD,kind:'PERSON'}},true,409],[{lead:{id:LEAD,kind:'COMPANY',initial_cnpj:'84429695000111'}},true,409]]){
  const f=fixture('confirm-company-candidate',options);assert.equal((await f.request({},auth)).status,status);assert.equal(f.events.length,0);assert.equal(f.writes.length,0);
 }
 const f=fixture('confirm-company-candidate');await f.request();
 assert.equal(f.reads.find(r=>r.table==='candidate_entities').eq.organization_id,ORG);
 assert.equal(f.reads.find(r=>r.table==='leads').eq.organization_id,ORG);
});

test('candidato rejeitado nunca é reaberto, inclusive no caminho societário legado',async()=>{
 for(const type of ['RFB_COMPANY_NAME_MATCH','RFB_QSA_NAME_MATCH']){
  const f=fixture('confirm-company-candidate');f.state.candidate.validation_status='REJECTED';f.state.candidate.candidate_type=type;
  assert.equal((await f.request()).status,409);assert.equal(f.events.length,0);assert.equal(f.writes.length,0);
 }
});

test('fonte original deve ser VERIFIED, cadastral e do CNPJ exato no mesmo lead/organização',async()=>{
 for(const doc of [null,{verification_status:'REJECTED'},{verification_status:'VERIFIED',source_registry_id:SOURCE,document_type:'WEB_PAGE'},{verification_status:'VERIFIED',source_registry_id:SOURCE,document_type:'CNPJ_REGISTRY',raw_reference:JSON.stringify({full_cnpj:'84429695000111'})}]){
  const f=fixture('confirm-company-candidate',{document:doc});assert.equal((await f.request()).status,409);assert.equal(f.events.length,0);assert.equal(f.writes.length,0);
 }
 const f=fixture('confirm-company-candidate');await f.request();const bound=f.reads.find(r=>r.table==='evidence');assert.deepEqual(bound.eq,{id:DOC,organization_id:ORG,lead_id:LEAD});
 const missing=fixture('confirm-company-candidate');delete missing.state.candidate.metadata.evidence_id;assert.equal((await missing.request()).status,409);assert.equal(missing.events.length,0);
 const readFailure=fixture('confirm-company-candidate',{documentError:true});assert.equal((await readFailure.request()).status,500);assert.equal(readFailure.events.length,0);
});

test('enriquecimento falho ou ainda revisado não atribui identidade nem confirma candidato',async()=>{
 for(const options of [{enrichmentHttp:502},{fetchThrows:true},{enrichment:{company_id:COMPANY,evidence_id:REGISTRY,status:'REVIEW_REQUIRED'}},{enrichment:{company_id:COMPANY}}]){
  const f=fixture('confirm-company-candidate',options),r=await f.request();assert.equal(r.status,options.enrichmentHttp||options.fetchThrows?502:409);assert.equal(f.events.filter(e=>e.kind==='rpc').length,0);assert.equal(f.writes.length,0);assert.doesNotMatch(await r.text(),/PRIVATE_UPSTREAM_MESSAGE/);
 }
});

test('CNPJ só é confirmado por RPC atômica após enriquecimento observado, sem escrita prévia de identidade',async()=>{
 const f=fixture('confirm-company-candidate'),r=await f.request();assert.equal(r.status,200);assert.deepEqual(f.events.map(e=>e.kind),['fetch','rpc']);assert.equal(f.writes.length,0);
 assert.equal(f.events[0].url,'https://qa.supabase.co/functions/v1/cnpj-enrich');assert.deepEqual(f.events[0].body,{lead_id:LEAD,cnpj:CNPJ});
 const rpc=f.events[1];assert.equal(rpc.name,'review_company_name_candidate');assert.deepEqual(rpc.args,{p_org:ORG,p_user:USER,p_candidate:CANDIDATE,p_action:'CONFIRM',p_reason:null,p_company:COMPANY,p_evidence:REGISTRY});
 const result=await r.json();assert.match(result.note,/entidade jurídica/);assert.match(result.note,/não atribui identidade de sócios/);
});

test('descarte concorrente ou documento revisado na RPC final bloqueia confirmação e falhas mantêm semântica HTTP',async()=>{
 for(const [code,status] of [['42501',403],['P0002',404],['22023',400],['P0001',409],['57014',500]]){
  const f=fixture('confirm-company-candidate',{rpcError:{code,message:'PRIVATE_DATABASE_MESSAGE'},rpcData:null}),r=await f.request();assert.equal(r.status,status);assert.equal(f.writes.length,0);assert.equal(f.events.filter(e=>e.kind==='rpc').length,1);assert.doesNotMatch(await r.text(),/PRIVATE_DATABASE_MESSAGE/);
 }
});

test('descarte empresarial altera somente a revisão pela RPC, sem motor pessoal ou remoção de outros vínculos',async()=>{
 const f=fixture('review-identity-candidate'),r=await f.request();assert.equal(r.status,200);assert.equal(f.writes.length,0);assert.equal(f.events.length,1);const rpc=f.events[0];assert.equal(rpc.kind,'rpc');assert.equal(rpc.name,'review_company_name_candidate');assert.deepEqual(rpc.args,{p_org:ORG,p_user:USER,p_candidate:CANDIDATE,p_action:'REJECT',p_reason:'Entidade jurídica incorreta',p_company:null,p_evidence:null});const body=await r.json();assert.equal(body.recomputed,null);assert.match(body.note,/preservados/);
 for(const [code,status] of [['42501',403],['P0002',404],['22023',400],['P0001',409],['57014',500]]){const blocked=fixture('review-identity-candidate',{rpcError:{code},rpcData:null});assert.equal((await blocked.request()).status,status);assert.equal(blocked.writes.length,0);assert.equal(blocked.events.length,1)}
});

test('revisão empresarial recusa sessão, perfil, tipo ou motivo inválido antes da RPC',async()=>{
 for(const [options,auth,status]of [[{},false,401],[{user:null},true,401],[{role:'VIEWER'},true,403],[{role:'UNKNOWN'},true,403],[{candidate:null},true,404]]){const f=fixture('review-identity-candidate',options);assert.equal((await f.request({},auth)).status,status);assert.equal(f.events.length,0);assert.equal(f.writes.length,0)}
 for(const body of [{candidate_id:'invalid'},{reason:'curto'.slice(0,4)},{reason:'x'.repeat(1001)},{action:'CONFIRM'}]){const f=fixture('review-identity-candidate');assert.equal((await f.request(body)).status,400);assert.equal(f.events.length,0)}
 const f=fixture('review-identity-candidate');f.state.candidate.entity_type='PERSON';assert.equal((await f.request()).status,409);assert.equal(f.events.length,0);
});
