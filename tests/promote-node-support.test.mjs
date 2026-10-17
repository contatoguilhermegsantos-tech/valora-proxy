import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {nodeLeadId,normalizeCompanyId} from '../supabase/functions/_shared/company-context.ts';

const ORG='10000000-0000-4000-8000-000000000001',USER='20000000-0000-4000-8000-000000000001',LEAD='30000000-0000-4000-8000-000000000001',COMPANY='40000000-0000-4000-8000-000000000001',DOC='50000000-0000-4000-8000-000000000001';
function fixture(patch={}){
 const relation={id:'r',organization_id:ORG,lead_id:LEAD,status:'VERIFIED',classification:'FACT',from_entity_type:'LEAD',from_entity_id:LEAD,to_entity_type:'COMPANY',to_entity_id:COMPANY,relationship_evidence:[{evidence_id:DOC,support_type:'SUPPORTS'}],...patch.relation};
 const document={id:DOC,organization_id:ORG,lead_id:LEAD,verification_status:'VERIFIED',...patch.document};
 const calls=[],writes=[],queue=[];
 const data={profiles:[{id:USER,active_organization_id:ORG}],organization_members:[{organization_id:ORG,user_id:USER,status:'ACTIVE',role:patch.role||'OWNER'}],leads:[{id:LEAD,organization_id:ORG,kind:'PERSON'}],relationships:[relation],evidence:patch.noDocument?[]:[document],companies:[{id:COMPANY,organization_id:ORG,cnpj:'32901144000105',legal_name:'Empresa QA',city:'Cidade QA',state:'SP'}],people:[],lead_company_links:[],claims:[]};
 const db={auth:{getUser:async()=>({data:{user:patch.user===null?null:{id:USER}},error:null})},from(table){
  let action='read',payload,single=false;const filters=[];const q={};
  q.select=()=>q;q.eq=(key,value)=>{filters.push({kind:'eq',key,value});return q};q.in=(key,value)=>{filters.push({kind:'in',key,value});return q};q.neq=(key,value)=>{filters.push({kind:'neq',key,value});return q};q.is=(key,value)=>{filters.push({kind:'eq',key,value});return q};q.order=()=>q;q.single=()=>{single=true;return q};q.maybeSingle=()=>{single=true;return q};
  for(const operation of ['insert','upsert','update'])q[operation]=value=>{action=operation;payload=value;return q};
  q.then=(resolve,reject)=>Promise.resolve().then(()=>{
   calls.push({table,action,filters});
   if(patch.readError===table&&action==='read')return{data:null,error:{message:'Controlled read error'}};
   if(action!=='read'){writes.push({table,action,payload});if(action==='insert')data[table].push(payload);return{data:single?payload:null,error:null};}
   const rows=(data[table]||[]).filter(row=>filters.every(f=>f.kind==='in'?f.value.includes(row[f.key]):f.kind==='neq'?row[f.key]!==f.value:row[f.key]===f.value));
   return{data:single?rows[0]||null:rows,count:table==='claims'?0:null,error:null};
  }).then(resolve,reject);return q;
 }};
 let handler;const source=fs.readFileSync(new URL('../supabase/functions/promote-node/index.ts',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'');
 vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText,{Deno:{env:{get:()=> 'https://qa.supabase.co'},serve:fn=>handler=fn},createClient:()=>db,nodeLeadId,normalizeCompanyId,Request,Response,AbortSignal,fetch:async(url,options)=>{queue.push({url,body:JSON.parse(options.body)});return Response.json({ok:true})},Set,Map,console});
 return{handler,calls,writes,queue};
}
const request=()=>new Request('https://qa.test',{method:'POST',headers:{Authorization:'Bearer controlled-qa','Content-Type':'application/json'},body:JSON.stringify({origin_lead_id:LEAD,entity_type:'COMPANY',entity_id:COMPANY})});

test('Reviewed, unsupported and foreign-scope relationships block before any lead or queue mutation',async()=>{
 for(const patch of [{relation:{status:'CONTRADICTED'}},{relation:{status:'REJECTED'}},{relation:{classification:'HYPOTHESIS'}},{noDocument:true},{document:{verification_status:'FAILED'}},{document:{verification_status:'STALE'}},{document:{lead_id:'another-lead'}},{document:{organization_id:'another-org'}},{relation:{relationship_evidence:[{evidence_id:DOC}]}},{relation:{relationship_evidence:[{evidence_id:DOC,support_type:'SUPPORTS'},{evidence_id:DOC,support_type:'CONTRADICTS'}]}}]){
  const f=fixture(patch),response=await f.handler(request());assert.equal(response.status,409);assert.equal(f.writes.length,0);assert.equal(f.queue.length,0);assert.equal(f.calls.some(c=>c.table==='companies'),false);
 }
});
test('A currently supported company node opens its independent CNPJ research without confirming origin identity',async()=>{
 const f=fixture(),response=await f.handler(request());assert.equal(response.status,200);const body=await response.json();assert.equal(body.lead.kind,'COMPANY');assert.equal(body.lead.initial_cnpj,'32901144000105');assert.equal(body.lead.identity_status,'PENDING');assert.equal(f.queue.length,1);assert.equal(f.queue[0].body.lead_id,body.lead.id);
 const docs=f.calls.find(c=>c.table==='evidence');assert.ok(docs.filters.some(f=>f.key==='organization_id'&&f.value===ORG));assert.ok(docs.filters.some(f=>f.key==='lead_id'&&f.value===LEAD));assert.ok(docs.filters.some(f=>f.key==='verification_status'&&f.value==='VERIFIED'));
 assert.equal(f.writes.some(w=>w.table==='relationships'||w.table==='evidence'),false);
});
test('Document read failure and unauthorized roles cannot produce a partially opened nucleus',async()=>{
 for(const patch of [{readError:'evidence'},{role:'VIEWER'},{role:'UNKNOWN'},{user:null}]){
  const f=fixture(patch),response=await f.handler(request());assert.equal(response.status,patch.readError?500:patch.user===null?401:403);assert.equal(f.writes.length,0);assert.equal(f.queue.length,0);
 }
});
