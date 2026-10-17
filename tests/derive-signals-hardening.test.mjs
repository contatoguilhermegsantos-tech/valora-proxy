import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const fixtureId=n=>String(n).padStart(8,'0')+'-1111-4111-8111-111111111111';
const ids={lead:fixtureId(1),org:fixtureId(2),user:fixtureId(3),company:fixtureId(4),doc:fixtureId(5),event:fixtureId(6),signal:fixtureId(7)};
const timestamp='2026-01-01T00:00:00.000Z';
function event(overrides={}){return {id:ids.event,organization_id:ids.org,lead_id:ids.lead,company_id:ids.company,event_type:'REGISTRATION_STATUS_CHANGE',title:'Evento cadastral sintético',classification:'FACT',status:'VERIFIED',event_evidence:[{evidence_id:ids.doc,support_type:'SUPPORTS'}],...overrides};}
function existing(type='CORPORATE_STATUS_EVENT',status='ACTIVE'){return {id:ids.signal,organization_id:ids.org,lead_id:ids.lead,signal_type:type,status,updated_at:timestamp,created_by:ids.user,evidence_ids:[ids.doc],event_ids:[ids.event],claim_ids:[]};}
function harness({role='OWNER',memberStatus='ACTIVE',events=[event()],docs,rels=[],claims=[],divs=[],signals=[],links,failRead,failWrite,beforeWrite,source}={}){
 const tables={
  profiles:[{id:ids.user,active_organization_id:ids.org}],
  organization_members:[{organization_id:ids.org,user_id:ids.user,role,status:memberStatus}],
  leads:[{id:ids.lead,organization_id:ids.org,kind:'COMPANY'}],
  events:structuredClone(events),relationships:structuredClone(rels),claims:structuredClone(claims),divergences:structuredClone(divs),
  evidence:structuredClone(docs??[{id:ids.doc,organization_id:ids.org,lead_id:ids.lead,verification_status:'VERIFIED'}]),
  lead_company_links:structuredClone(links??[{organization_id:ids.org,lead_id:ids.lead,company_id:ids.company,status:'SUPPORTED'}]),
  commercial_signals:structuredClone(signals),
 };
 const writes=[],reads=[];let handler,sequence=20;
 const db={auth:{getUser:async()=>({data:{user:{id:ids.user}}})},from(table){
  const filters=[];let operation='read',payload,singular=false;
  const q={select(){return q},order(){return q},eq(k,v){filters.push(r=>r[k]===v);return q},in(k,v){filters.push(r=>v.includes(r[k]));return q},not(k,op,v){filters.push(r=>!String(v).replace(/[()]/g,'').split(',').includes(r[k]));return q},maybeSingle(){singular=true;return q},single(){singular=true;return q},update(v){operation='update';payload=v;return q},insert(v){operation='insert';payload=v;return q}};
  q.then=(resolve,reject)=>Promise.resolve().then(()=>{
   reads.push({table,operation});
   if(operation==='read'&&failRead===table||operation!=='read'&&failWrite===table)return {data:null,error:{message:'Synthetic database failure'}};
   if(operation!=='read')beforeWrite?.({tables,table,operation,payload});
   let rows=(tables[table]||[]).filter(r=>filters.every(f=>f(r)));
   if(operation==='update'){rows.forEach(r=>Object.assign(r,structuredClone(payload)));writes.push({table,operation,payload:structuredClone(payload),matched:rows.length});}
   if(operation==='insert'){rows=(Array.isArray(payload)?payload:[payload]).map(r=>({id:fixtureId(sequence++),...structuredClone(r)}));tables[table]??=[];tables[table].push(...rows);writes.push({table,operation,payload:structuredClone(payload),matched:rows.length});}
   return {data:singular?rows[0]||null:structuredClone(rows),error:null};
  }).then(resolve,reject);return q;
 }};
 const code=(source||fs.readFileSync(process.env.DERIVE_SIGNALS_QA_SOURCE||new URL('../supabase/functions/derive-signals/index.ts',import.meta.url),'utf8')).replace(/^import .*;\r?\n/gm,'');
 vm.runInNewContext(ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText,{Deno:{env:{get:()=> 'https://test.invalid'},serve:f=>{handler=f}},createClient:()=>db,Request,Response,console,Date,Set,Map});
 return {tables,writes,reads,call:async(auth=true)=>{const r=await handler(new Request('https://test.invalid',{method:'POST',headers:{'Content-Type':'application/json',...(auth?{Authorization:'Bearer synthetic'}:{})},body:JSON.stringify({lead_id:ids.lead})}));return {status:r.status,data:await r.json()};}};
}
test('negar escrita a VIEWER e membro inativo antes das fontes',async()=>{
 for(const options of [{role:'VIEWER'},{memberStatus:'INACTIVE'}]){const h=harness(options),r=await h.call();assert.equal(r.status,403);assert.equal(h.writes.length,0);assert.ok(!h.reads.some(x=>x.table==='events'));}
});
test('ausência de sessão não grava sinal',async()=>{const h=harness();assert.equal((await h.call(false)).status,401);assert.equal(h.writes.length,0);});
test('evento contraditado não gera FACT ou qualquer sinal derivado',async()=>{const h=harness({events:[event({status:'CONTRADICTED'})]});assert.equal((await h.call()).status,200);assert.equal(h.tables.commercial_signals.length,0);});
test('evento sem evidência verificada própria ou com CONTRADICTS é excluído',async()=>{
 for(const options of [
  {docs:[{id:ids.doc,organization_id:ids.org,lead_id:ids.lead,verification_status:'FAILED'}]},
  {docs:[{id:ids.doc,organization_id:fixtureId(99),lead_id:ids.lead,verification_status:'VERIFIED'}]},
  {docs:[{id:ids.doc,organization_id:ids.org,lead_id:fixtureId(99),verification_status:'VERIFIED'}]},
  {events:[event({event_evidence:[{evidence_id:ids.doc,support_type:'CONTRADICTS'}]})]},
  {events:[event({classification:'INDICATION'})]},
  {events:[event({event_evidence:[{evidence_id:ids.doc}]})]},
 ]){const h=harness(options);assert.equal((await h.call()).status,200);assert.equal(h.tables.commercial_signals.length,0);}
});
test('empresa rejeitada ou ainda pendente não sustenta sinal',async()=>{for(const status of ['REJECTED','CONTRADICTED','PENDING']){const h=harness({links:[{organization_id:ids.org,lead_id:ids.lead,company_id:ids.company,status}]});assert.equal((await h.call()).status,200);assert.equal(h.tables.commercial_signals.length,0);}});
test('evento documental com apoio vigente gera sinal e reconsulta não duplica',async()=>{const h=harness();assert.equal((await h.call()).status,200);assert.equal(h.tables.commercial_signals.length,1);const s=h.tables.commercial_signals[0];assert.equal(s.classification,'FACT');assert.equal(s.status,'ACTIVE');assert.deepEqual(s.evidence_ids,[ids.doc]);assert.deepEqual(s.event_ids,[ids.event]);await h.call();assert.equal(h.tables.commercial_signals.length,1);});
test('perda de apoio torna sinal automático STALE, sem apagar histórico',async()=>{const h=harness({events:[],signals:[existing()]});assert.equal((await h.call()).status,200);assert.equal(h.tables.commercial_signals[0].status,'STALE');assert.deepEqual(h.tables.commercial_signals[0].evidence_ids,[ids.doc]);});
test('revisões DISMISSED e STALE não são reativadas nem duplicadas',async()=>{for(const status of ['DISMISSED','STALE']){const h=harness({signals:[existing('CORPORATE_STATUS_EVENT',status)]});assert.equal((await h.call()).status,200);assert.equal(h.tables.commercial_signals.length,1);assert.equal(h.tables.commercial_signals[0].status,status);assert.equal(h.writes.length,0);}});
test('tipo de sinal fora do conector permanece intacto',async()=>{const h=harness({events:[],signals:[existing('MANUAL_REVIEW_NOTE')]});assert.equal((await h.call()).status,200);assert.equal(h.tables.commercial_signals[0].status,'ACTIVE');assert.equal(h.writes.length,0);});
test('revisão humana concorrente vence o CAS de atualização e de invalidação',async()=>{
 for(const events of [[event()],[]]){let moved=false;const h=harness({events,signals:[existing()],beforeWrite:({tables,table})=>{if(table==='commercial_signals'&&!moved){moved=true;tables.commercial_signals[0].status='DISMISSED';tables.commercial_signals[0].updated_at='2026-01-02T00:00:00.000Z';}}});assert.equal((await h.call()).status,200);assert.equal(h.tables.commercial_signals[0].status,'DISMISSED');assert.equal(h.writes[0].matched,0);}
});
test('erro de leitura impede declarar ausência de base ou invalidar sinal',async()=>{for(const failRead of ['organization_members','events','relationships','claims','divergences','commercial_signals','evidence','lead_company_links']){const h=harness({failRead,signals:[existing()]});assert.equal((await h.call()).status,500,failRead);assert.equal(h.writes.length,0,failRead);assert.equal(h.tables.commercial_signals[0].status,'ACTIVE');}});
test('falha de gravação não responde sucesso',async()=>{for(const options of [{failWrite:'commercial_signals'},{failWrite:'commercial_signals',events:[],signals:[existing()]}])assert.equal((await harness(options).call()).status,500);});
test('sucessão exige FACT e documentos atuais sem parentesco presumido',async()=>{
 const family={id:fixtureId(9),organization_id:ids.org,lead_id:ids.lead,relationship_type:'FAMILIAR_CONFIRMADO',classification:'FACT',status:'VERIFIED',relationship_evidence:[{evidence_id:ids.doc,support_type:'SUPPORTS'}]};
 const holding=event({event_type:'HOLDING_CREATED'});
 const h=harness({events:[holding],rels:[family]});assert.equal((await h.call()).status,200);assert.equal(h.tables.commercial_signals[0].signal_type,'POSSIBLE_SUCCESSION');assert.equal(h.tables.commercial_signals[0].classification,'HYPOTHESIS');
 const bad=harness({events:[holding],rels:[{...family,status:'CONTRADICTED'}]});await bad.call();assert.equal(bad.tables.commercial_signals.length,0);
});
test('sinal BNDES inclui apenas operações com apoio verificado e próprio',async()=>{const h=harness({events:[event({event_type:'BNDES_FINANCING',metadata:{contracted_value:100}}),event({id:fixtureId(10),event_type:'BNDES_FINANCING',status:'CONTRADICTED',metadata:{contracted_value:9999}})]});await h.call();const s=h.tables.commercial_signals[0];assert.equal(s.signal_type,'BNDES_FINANCING_HISTORY');assert.deepEqual(s.event_ids,[ids.event]);assert.doesNotMatch(s.summary,/9.999/);});

