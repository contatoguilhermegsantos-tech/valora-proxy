import {sourceBatches} from '../supabase/functions/_shared/source-batches.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {fetchSourceJson,advanceCoverage} from '../supabase/functions/_shared/source-operations.ts';

// In-memory transport exercises the deployed handlers, including their database filters.
function database() {
 const tables={system_internal_tokens:[{key:'pncp_sync',token:'test-only'}],source_backfill_queue:[{id:'q',source_key:'pncp',target_date:'2026-09-28',next_page:1,status:'RUNNING',attempts:0}],source_sync_state:[{source_key:'pncp',last_successful_date:'2026-09-27'}],connector_run_log:[],public_contract_index:[],source_registry:[{key:'pncp'}]};
 return {tables,from(name){
  const filters=[];let operation='read',payload,options={},single=false,limit=Infinity,order;
  const q={
   select(){return q},eq(k,v){filters.push(r=>r[k]===v);return q},gt(k,v){filters.push(r=>r[k]>v);return q},gte(k,v){filters.push(r=>r[k]>=v);return q},lt(k,v){filters.push(r=>r[k]!=null&&r[k]<v);return q},in(k,v){filters.push(r=>v.includes(r[k]));return q},order(k){order=k;return q},limit(n){limit=n;return q},maybeSingle(){single=true;return q},single(){single=true;return q},insert(v){operation='insert';payload=v;return q},update(v){operation='update';payload=v;return q},upsert(v,o){operation='upsert';payload=v;options=o;return q},
   then(resolve,reject){return Promise.resolve().then(()=>{
    let rows=tables[name].filter(r=>filters.every(f=>f(r)));
    if(order)rows.sort((a,b)=>String(a[order]).localeCompare(String(b[order])));rows=rows.slice(0,limit);
    if(operation==='update')rows.forEach(r=>Object.assign(r,payload));
    if(operation==='insert'){rows=[{id:'run-'+tables[name].length,...payload}];tables[name].push(...rows)}
    if(operation==='upsert'){rows=[];for(const item of Array.isArray(payload)?payload:[payload]){const keys=options.onConflict.split(',');let found=tables[name].find(r=>keys.every(k=>r[k]===item[k]));if(found){if(!options.ignoreDuplicates)Object.assign(found,item)}else{found={...item};tables[name].push(found)}rows.push(found)}}
    return {data:single?structuredClone(rows[0]||null):structuredClone(rows),error:null};
   }).then(resolve,reject)}
  };return q;
 }};
}
function handler(name,db,fetcher){
 const source=fs.readFileSync(new URL('../supabase/functions/'+name+'/index.ts',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'');
 let serve;
 vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText,{Deno:{env:{get:()=> 'https://test.supabase.co'},serve:fn=>{serve=fn}},createClient:()=>db,fetch:fetcher,fetchSourceJson:(url,valid)=>fetchSourceJson(url,valid,{fetcher,wait:async()=>{}}),advanceCoverage,sourceBatches,Response,Request,URL,AbortSignal,Date,Map,Number,String,JSON,Math,setTimeout:fn=>{fn();return 0}});
 return body=>serve(new Request('https://test.supabase.co',{method:'POST',headers:{'X-MAX-SYNC-TOKEN':'test-only','Content-Type':'application/json'},body:JSON.stringify(body)}));
}
test('PNCP retoma a página não salva, mantém tamanho 100 e só conclui no fim',async()=>{
 const db=database(),seen=[];let fail=true;
 const sync=handler('pncp-sync-contracts',db,async url=>{
  const u=new URL(url),page=Number(u.searchParams.get('pagina'));seen.push([page,u.searchParams.get('tamanhoPagina')]);
  if(fail&&page===2)return new Response('',{status:429,headers:{'Retry-After':'60'}});
  return Response.json({totalPaginas:8,data:[{numeroControlePNCP:'contract-'+page,niFornecedor:'32901144000105',tipoPessoa:'PJ'}]});
 });
 const body={queue_id:'q',date_from:'2026-09-28',date_to:'2026-09-28'};
 let response=await (await sync(body)).json();assert.equal(response.status,'PARTIAL');assert.equal(db.tables.source_backfill_queue[0].next_page,2);assert.equal(db.tables.source_sync_state[0].last_successful_date,'2026-09-27');
 fail=false;response=await (await sync(body)).json();assert.equal(response.status,'PARTIAL');assert.equal(db.tables.source_backfill_queue[0].next_page,7);
 response=await (await sync(body)).json();assert.equal(response.status,'SUCCESS');assert.equal(db.tables.source_sync_state[0].last_successful_date,'2026-09-28');assert.equal(db.tables.public_contract_index.length,8);
 assert.ok(seen.every(x=>x[1]==='100'));assert.deepEqual(seen.map(x=>x[0]),[1,2,2,3,4,5,6,7,8]);
});
test('dois workers concorrentes não processam a mesma data; progresso reenfileira',async()=>{
 const db=database();db.tables.source_backfill_queue[0].status='PENDING';let calls=0;
 const worker=handler('pncp-backfill-step',db,async()=>{calls++;db.tables.source_backfill_queue[0].next_page=6;return Response.json({status:'PARTIAL'})});
 const results=await Promise.all([worker({}),worker({})]);const statuses=await Promise.all(results.map(r=>r.json()));
 assert.equal(calls,1);assert.deepEqual(statuses.map(r=>r.status).sort(),['BUSY','PENDING']);assert.equal(db.tables.source_backfill_queue[0].attempts,0);
});
test('worker interrompido recupera lease; falha mantém checkpoint e incrementa tentativa',async()=>{
 const db=database(),item=db.tables.source_backfill_queue[0];item.next_page=6;item.started_at='2026-01-01T00:00:00Z';
 const worker=handler('pncp-backfill-step',db,async()=>{throw new TypeError('network')});
 const response=await worker({});assert.equal(response.status,502);assert.equal(item.next_page,6);assert.equal(item.status,'FAILED');assert.equal(item.attempts,1);
});
test('quatro falhas permanecem terminais mesmo após seis horas',async()=>{
 const db=database(),item=db.tables.source_backfill_queue[0];Object.assign(item,{status:'FAILED',attempts:4,next_page:6,finished_at:new Date().toISOString()});let calls=0;
 const worker=handler('pncp-backfill-step',db,async()=>{calls++;return Response.json({status:'SUCCESS'})});
 assert.equal((await (await worker({})).json()).status,'IDLE');assert.equal(calls,0);
 item.finished_at='2026-01-01T00:00:00Z';assert.equal((await (await worker({})).json()).status,'IDLE');assert.equal(calls,0);assert.equal(item.next_page,6);assert.equal(item.attempts,4);
});
