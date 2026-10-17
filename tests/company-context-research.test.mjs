import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const USER='11111111-1111-4111-8111-111111111111',ORG='22222222-2222-4222-8222-222222222222',LEAD='33333333-3333-4333-8333-333333333333',COMPANY='44444444-4444-4444-8444-444444444444',RUN='55555555-5555-4555-8555-555555555555';
function fixture(overrides={}){
 const state={role:'OWNER',memberStatus:'ACTIVE',authenticated:true,leadFound:true,companyFound:true,linkStatus:'SUPPORTED',sourceRows:[],planError:false,finalError:false,...overrides},writes=[],reads=[],calls=[],steps=[];
 const db={auth:{getUser:async()=>({data:{user:state.authenticated?{id:USER}:null},error:null})},from:table=>{
  let mode='read',payload,columns;const eq={};const q={};
  q.select=v=>{columns=v;return q};q.eq=(k,v)=>{eq[k]=v;return q};for(const n of ['single','maybeSingle','order','limit'])q[n]=()=>q;
  for(const n of ['insert','update'])q[n]=v=>{mode=n;payload=JSON.parse(JSON.stringify(v));return q};
  q.then=(resolve,reject)=>Promise.resolve().then(()=>{
   const op={table,mode,payload,columns,eq:{...eq}};(mode==='read'?reads:writes).push(op);
   if(state.readError===table&&mode==='read')return {data:null,error:{message:'Controlled read failure'}};
   if(table==='profiles')return {data:{active_organization_id:ORG},error:null};
   if(table==='organization_members')return {data:{status:state.memberStatus,role:state.role},error:null};
   if(table==='leads')return {data:state.leadFound?{id:LEAD,name:'Synthetic person'}:null,error:null};
   if(table==='companies')return {data:state.companyFound?{id:COMPANY,cnpj:'32901144000105',legal_name:'Synthetic business'}:null,error:null};
   if(table==='lead_company_links')return {data:state.linkStatus?{id:COMPANY,status:state.linkStatus}:null,error:null};
   if(table==='source_registry')return {data:state.sourceRows,error:null};
   if(table==='research_runs'){
    if(mode==='insert')return {data:{id:RUN},error:null};
    if(mode==='update'&&state.finalError&&payload.status!=='FAILED')return {data:null,error:{message:'Controlled final persistence failure'}};
    return {data:{id:RUN},error:null};
   }
   if(table==='research_steps'){
    if(mode==='insert'){
     if(state.planError)return {data:null,error:{message:'Controlled plan persistence failure'}};
     steps.push(...payload.map((x,i)=>({...x,id:COMPANY+'-'+i})));return {data:steps,error:null};
    }
    if(mode==='update'){
     if(state.stepError)return {data:null,error:{message:'Controlled step persistence failure'}};
     const row=steps.find(x=>x.step_key===eq.step_key);if(row)Object.assign(row,payload);return {data:row?{id:row.id}:null,error:null};
    }
    if(state.finalReadError)return {data:null,error:{message:'Controlled step read failure'}};
    return {data:steps,error:null};
   }
   return {data:[],error:null};
  }).then(resolve,reject);return q;
 }};
 let handler;const raw=fs.readFileSync(new URL('../supabase/functions/company-context-research/index.ts',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'');
 const fetcher=async(url,init)=>{calls.push({fn:url.split('/').at(-1),init});if(state.fetchFailure)throw Error('Controlled fetch failure');if(state.rejectAfterFetch)state.linkStatus='REJECTED';if(state.advanceAfterFetch)state.clock=(state.clock||Date.now())+state.advanceAfterFetch;return Response.json(state.sourceResponse||{ok:true,signals:[]});};
 class Clock extends Date {static now(){return state.clock||Date.now()}}
 vm.runInNewContext(ts.transpileModule(raw,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText,{Deno:{env:{get:()=> 'https://synthetic.supabase.co'},serve:fn=>{handler=fn}},createClient:()=>db,fetch:fetcher,Request,Response,AbortSignal,Date:Clock,console});
 const request=(body={lead_id:LEAD,company_id:COMPANY},auth=true)=>handler(new Request('https://synthetic.test',{method:'POST',headers:{...(auth?{Authorization:'Bearer synthetic'}:{}),'Content-Type':'application/json'},body:JSON.stringify(body)}));
 return {state,writes,reads,calls,steps,request};
}

test('company context denies missing/expired auth and all non-writer roles before writes',async()=>{
 for(const o of [{role:'VIEWER'},{role:'UNKNOWN'},{memberStatus:'INACTIVE'},{authenticated:false}]){
  const f=fixture(o),r=await f.request();assert.equal(r.status,o.authenticated===false?401:403);assert.equal(f.writes.length,0);assert.equal(f.calls.length,0);
 }
 const f=fixture();assert.equal((await f.request(undefined,false)).status,401);assert.equal(f.writes.length,0);
});

test('company context requires a current scoped lead/company link and preserves reviewed attribution',async()=>{
 for(const status of [null,'REJECTED','CONTRADICTED']){
  const f=fixture({linkStatus:status}),r=await f.request();assert.equal(r.status,409);assert.equal(f.writes.length,0);assert.equal(f.calls.length,0);
 }
 for(const o of [{leadFound:false},{companyFound:false}]){
  const f=fixture(o);assert.equal((await f.request()).status,404);assert.equal(f.writes.length,0);
 }
 const f=fixture();assert.equal((await f.request({lead_id:'invalid',company_id:COMPANY})).status,400);assert.equal(f.writes.length,0);
});

test('company context writes an honest PARTIAL plan with scoped updates and bounded calls',async()=>{
 const f=fixture(),r=await f.request();assert.equal(r.status,200);const result=await r.json();assert.equal(result.status,'PARTIAL');assert.equal(result.counters.blocked,6);
 const link=f.reads.find(x=>x.table==='lead_company_links');assert.deepEqual(link.eq,{organization_id:ORG,lead_id:LEAD,company_id:COMPANY});
 for(const op of f.writes.filter(x=>x.mode==='update'))assert.equal(op.eq.organization_id,ORG);
 assert.ok(f.calls.every(x=>x.init.signal instanceof AbortSignal));assert.equal(f.calls.length,1);
 assert.ok(f.writes.every(x=>['research_runs','research_steps'].includes(x.table)));
});

test('plan/step/read/final persistence failures never become completed research',async()=>{
 for(const o of [{planError:true},{stepError:true},{finalReadError:true},{finalError:true}]){
  const f=fixture(o),r=await f.request();assert.equal(r.status,500);const result=await r.json();assert.equal(result.research_run_id,RUN);assert.notEqual(result.status,'COMPLETED');
  if(o.planError||o.stepError)assert.equal(f.calls.length,0);
 }
 for(const table of ['profiles','organization_members','leads','companies','lead_company_links','source_registry']){
  const f=fixture({readError:table});assert.equal((await f.request()).status,500);assert.equal(f.writes.length,0);
 }
});

test('partial source responses remain partial even when records exist',async()=>{
 const f=fixture({sourceRows:[{key:'bndes_financing',name:'BNDES',connection_status:'CONNECTED_LIMITED'}],sourceResponse:{ok:true,complete:false,status:'PARTIAL',operations_found:1,signals:[]}}),r=await f.request();assert.equal(r.status,200);
 const step=f.steps.find(x=>x.step_key==='bndes_financing');assert.equal(step.status,'PARTIAL');assert.equal((await r.json()).status,'PARTIAL');
});

test('blocked and invalid source bodies do not become successful coverage',async()=>{
 for(const body of [{ok:true,status:'BLOCKED',operations_found:1},{ok:false,error:'Synthetic source failure'}]){
  const f=fixture({sourceRows:[{key:'bndes_financing',name:'BNDES',connection_status:'CONNECTED_LIMITED'}],sourceResponse:body}),r=await f.request();assert.equal(r.status,200);
  const step=f.steps.find(x=>x.step_key==='bndes_financing');assert.equal(step.status,body.ok?'BLOCKED':'FAILED');assert.equal((await r.json()).status,'PARTIAL');
 }
});

test('a review committed during a source call stops further company research without touching attribution',async()=>{
 const f=fixture({rejectAfterFetch:true,sourceRows:[{key:'bndes_financing',connection_status:'CONNECTED_LIMITED'},{key:'cvm',connection_status:'CONNECTED_LIMITED'}],sourceResponse:{ok:true,operations_found:1}}),r=await f.request();
 assert.equal(r.status,500);assert.equal((await r.json()).status,'FAILED');assert.deepEqual(f.calls.map(x=>x.fn),['bndes-company-financing']);
 assert.ok(f.writes.every(x=>['research_runs','research_steps'].includes(x.table)));
});

test('the shared round deadline preserves completed work and marks unqueried sources/signals partial',async()=>{
 const f=fixture({advanceAfterFetch:121000,sourceRows:[{key:'bndes_financing',connection_status:'CONNECTED_LIMITED'},{key:'cvm',connection_status:'CONNECTED_LIMITED'}],sourceResponse:{ok:true,operations_found:1}}),r=await f.request();
 assert.equal(r.status,200);assert.equal((await r.json()).status,'PARTIAL');assert.deepEqual(f.calls.map(x=>x.fn),['bndes-company-financing']);
 assert.equal(f.steps.find(x=>x.step_key==='bndes_financing').status,'COMPLETED');assert.equal(f.steps.find(x=>x.step_key==='cvm').status,'PARTIAL');assert.equal(f.steps.find(x=>x.step_key==='signals').status,'PARTIAL');
});
