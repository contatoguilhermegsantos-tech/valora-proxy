import test from 'node:test';
import assert from 'node:assert/strict';
import {deflateRawSync} from 'node:zlib';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {crc32,fetchDfpFinancials,extractFinancialFacts,scaleAmount} from '../supabase/functions/_shared/cvm-dfp.ts';
import {persistDfpFacts,financialValueText} from '../supabase/functions/_shared/cvm-financial-persistence.ts';
const CNPJ='84429695000111',YEAR=2025;
const HEAD=['CNPJ_CIA','DT_REFER','VERSAO','DENOM_CIA','CD_CVM','GRUPO_DFP','MOEDA','ESCALA_MOEDA','ORDEM_EXERC','DT_INI_EXERC','DT_FIM_EXERC','CD_CONTA','DS_CONTA','VL_CONTA','ST_CONTA_FIXA'];
const row=(extra={})=>({CNPJ_CIA:'84.429.695/0001-11',DT_REFER:'2025-12-31',VERSAO:'1',DENOM_CIA:'Companhia QA',CD_CVM:'5410',GRUPO_DFP:'DF Consolidado - Demonstração do Resultado',MOEDA:'REAL',ESCALA_MOEDA:'MIL',ORDEM_EXERC:'ÚLTIMO',DT_INI_EXERC:'2025-01-01',DT_FIM_EXERC:'2025-12-31',CD_CONTA:'3.01',DS_CONTA:'Receita de Venda de Bens e/ou Serviços',VL_CONTA:'1234.5000000000',ST_CONTA_FIXA:'S',...extra});
function makeZip(overrides={}){
 const members=['BPA','BPP','DRE'].map(s=>{const extra=overrides.byStatement?.[s]||overrides;return {name:`dfp_cia_aberta_${s}_con_${YEAR}.csv`,text:HEAD.join(';')+'\n'+HEAD.map(h=>(s==='DRE'?row(extra):row({...extra,CD_CONTA:'99',DS_CONTA:'Sem conta selecionada'}))[h]).join(';')+'\n'}});
 const locals=[],centrals=[];let offset=0;
 for(const m of members){const raw=Buffer.from(m.text,'latin1'),data=deflateRawSync(raw),name=Buffer.from(m.name);const h=Buffer.alloc(30);h.writeUInt32LE(0x04034b50);h.writeUInt16LE(20,4);h.writeUInt16LE(8,8);h.writeUInt32LE(crc32(raw),14);h.writeUInt32LE(data.length,18);h.writeUInt32LE(raw.length,22);h.writeUInt16LE(name.length,26);locals.push(h,name,data);const c=Buffer.alloc(46);c.writeUInt32LE(0x02014b50);c.writeUInt16LE(20,4);c.writeUInt16LE(20,6);c.writeUInt16LE(8,10);c.writeUInt32LE(crc32(raw),16);c.writeUInt32LE(data.length,20);c.writeUInt32LE(raw.length,24);c.writeUInt16LE(name.length,28);c.writeUInt32LE(offset,42);centrals.push(c,name);offset+=h.length+name.length+data.length}
 const cd=Buffer.concat(centrals),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(3,8);end.writeUInt16LE(3,10);end.writeUInt32LE(cd.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...locals,cd,end]);
}
const transport=(zip,change)=>async(_url,options)=>{
 const range=options.headers.Range,m=range.match(/^bytes=(\d*)-(\d+)$/),start=m[1]?Number(m[1]):Math.max(0,zip.length-Number(m[2])),end=m[1]?Number(m[2]):zip.length-1;
 const r=new Response(zip.subarray(start,end+1),{status:206,headers:{'Content-Range':`bytes ${start}-${end}/${zip.length}`,ETag:'"qa-v1"'}});return change?change(r,options):r;
};
test('DFP seleciona CNPJ completo, exercício último, consolidado e maior versão',()=>{
 const rows=[row({VERSAO:'1',VL_CONTA:'100'}),row({VERSAO:'2',VL_CONTA:'200'}),row({VERSAO:'2',ORDEM_EXERC:'PENÚLTIMO',VL_CONTA:'300'}),row({CNPJ_CIA:'84.429.695/0002-00',VL_CONTA:'400'}),row({GRUPO_DFP:'DF Individual',VL_CONTA:'500'})];const facts=extractFinancialFacts(rows,CNPJ,YEAR,'DRE');assert.equal(facts.length,1);assert.equal(facts[0].amount_brl,'200000');assert.equal(facts[0].version,2);assert.equal(facts[0].period_start,'2025-01-01');assert.equal(facts[0].scope,'CONSOLIDATED');
});
test('DFP rejeita escalas/moedas/contas não fixas e não inventa receita para bancos',()=>{
 for(const change of [{ESCALA_MOEDA:'MILHAO'},{MOEDA:'DOLAR'},{DS_CONTA:'Receitas da Intermediação Financeira'},{ST_CONTA_FIXA:'N'},{DT_REFER:'2024-12-31'},{DT_INI_EXERC:'2026-01-01'},{DT_REFER:'2025-99-99',DT_FIM_EXERC:'2025-99-99'}])assert.deepEqual(extractFinancialFacts([row(change)],CNPJ,YEAR,'DRE'),[]);
 assert.equal(scaleAmount('1234.5000000000','MIL'),'1234500');assert.equal(scaleAmount('-0.001','MIL'),'-1');assert.equal(scaleAmount('0.0001','UNIDADE'),'0.0001');assert.equal(scaleAmount('9007199254740993.25','MIL'),'9007199254740993250');assert.equal(scaleAmount('1,25','MIL'),null);
});
test('DFP recusa valores conflitantes da mesma conta, período e versão',()=>assert.throws(()=>extractFinancialFacts([row(),row({VL_CONTA:'999'})],CNPJ,YEAR,'DRE'),/Conflicting/));
test('ZIP DFP usa ranges validados e retorna fatos sem carregar ZIP completo',async()=>{
 const zip=makeZip(),calls=[];const f=async(...args)=>{calls.push(args[1].headers);return transport(zip)(...args)};
 const result=await fetchDfpFinancials(CNPJ,YEAR,f,new Date('2026-10-01'));assert.equal(result.facts.length,1);assert.equal(result.facts[0].amount_brl,'1234500');assert.equal(calls.length,7);assert.ok(calls.slice(1).every(h=>h['If-Range']==='"qa-v1"'));assert.ok(calls.every(h=>h.Range));
 const other=await fetchDfpFinancials('89096457000155',YEAR,transport(zip),new Date('2026-10-01'));assert.equal(other.facts.length,0);
});
test('DFP recusa ano aberto sem consultar a fonte',async()=>{let called=false;await assert.rejects(fetchDfpFinancials(CNPJ,2026,async()=>{called=true},new Date('2026-10-01')),/Closed reference year/);assert.equal(called,false)});
test('DFP compara versões dos demonstrativos mesmo sem contas selecionadas em BPA/BPP',async()=>{
 const zip=makeZip({byStatement:{BPA:{VERSAO:'2'},BPP:{VERSAO:'2'},DRE:{VERSAO:'1'}}});
 await assert.rejects(fetchDfpFinancials(CNPJ,YEAR,transport(zip),new Date('2026-10-01')),/inconsistent versions/);
 const consistent=makeZip({byStatement:{BPA:{VERSAO:'2'},BPP:{VERSAO:'2'},DRE:{VERSAO:'2'}}});
 const result=await fetchDfpFinancials(CNPJ,YEAR,transport(consistent),new Date('2026-10-01'));assert.equal(result.facts.length,1);assert.equal(result.facts[0].version,2);
});
test('ZIP DFP recusa servidor sem ranges, ETag alterado e range truncado',async()=>{
 for(const change of [r=>new Response(r.body,{status:200,headers:r.headers}),r=>{r.headers.set('Content-Range','bytes 1-2/3');return r},(r,o)=>{if(o.headers['If-Range'])r.headers.set('ETag','"different"');return r}])await assert.rejects(fetchDfpFinancials(CNPJ,YEAR,transport(makeZip(),change),new Date('2026-10-01')));
});
test('ZIP DFP recusa CRC adulterado e tamanho de saída excessivo antes da descompressão',async()=>{
 for(const corrupt of [zip=>{const p=zip.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));zip.writeUInt32LE(123,p+16)},zip=>{const p=zip.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));zip.writeUInt32LE(40*1024*1024,p+24)}]){const zip=makeZip();corrupt(zip);await assert.rejects(fetchDfpFinancials(CNPJ,YEAR,transport(zip),new Date('2026-10-01')))}
});
function database({evidenceStatus='VERIFIED',claimStatus='PENDING',failure,afterTriggerStatus='VERIFIED'}={}){
 const writes=[],claims=[];let updated=false;
 return {writes,claims,from(table){let operation='read',payload,eqs={};const q={};for(const name of ['select','single','maybeSingle','not'])q[name]=()=>q;q.eq=(key,value)=>{eqs[key]=value;return q};for(const name of ['upsert','insert','update'])q[name]=p=>{operation=name;payload=p;return q};q.then=(resolve,reject)=>Promise.resolve().then(()=>{
  if(operation!=='read')writes.push({table,operation,payload});if(failure===table&&operation!=='read')return {error:{message:'QA write failed'},data:null};
  if(table==='evidence')return {data:operation==='read'&&!/[0-9a-f]{64}$/.test(eqs.dedupe_key||'')?null:{id:'evidence',verification_status:evidenceStatus},error:null};
  if(table==='claims'){if(operation==='insert'){claims.push(payload);return {data:{id:'claim'},error:null}}if(operation==='update'){updated=true;return {data:[{id:'claim'}],error:null}}return {data:updated&&eqs.id?{id:'claim',status:afterTriggerStatus}:claimStatus==='NONE'?null:{id:'claim',status:claimStatus},error:null}}
  return {data:null,error:null};
 }).then(resolve,reject);return q}};
}
const ctx={organization_id:'o',lead_id:'lead',company_id:'company',source_registry_id:'source',created_by:'user'};
const fixture=()=>({cnpj:CNPJ,year:YEAR,source_url:'https://dados.cvm.gov.br/test.zip',archive_etag:'"v1"',members:[],facts:extractFinancialFacts([row()],CNPJ,YEAR,'DRE')});
test('DFP conserva diferença decimal exata na identidade persistida apesar do mesmo display em centavos',async()=>{
 const facts=['10.001','10.002'].map(amount_brl=>({...fixture().facts[0],amount_brl,original_value:amount_brl,original_scale:'UNIDADE'}));
 const texts=facts.map(financialValueText);assert.ok(texts.every(text=>text.startsWith('R$ 10,00')));assert.notEqual(texts[0],texts[1]);assert.match(texts[0],/valor exato BRL 10\.001/);assert.match(texts[1],/valor exato BRL 10\.002/);
 const db=database({claimStatus:'NONE'});await persistDfpFacts(db,ctx,{...fixture(),facts});assert.equal(db.claims.length,2);assert.notEqual(db.claims[0].value_text,db.claims[1].value_text);assert.equal(db.claims[0].value_json.financial_document.amount_brl,'10.001');assert.equal(db.claims[1].value_json.financial_document.amount_brl,'10.002');
});
test('DFP preserva evidência e fato rejeitados sem promover novamente',async()=>{
 for(const state of [{evidenceStatus:'REJECTED'},{claimStatus:'REJECTED'},{claimStatus:'CONTRADICTED'}]){const db=database(state),result=await persistDfpFacts(db,ctx,fixture());assert.equal(result.claim_ids.length,0);assert.equal(result.review_required,1);assert.ok(!db.writes.some(w=>w.table==='claims'&&w.operation==='update'))}
});
test('DFP confirma suporte antes de verificar fato e conserva escala/período em value_json',async()=>{
 const db=database({claimStatus:'NONE'}),result=await persistDfpFacts(db,ctx,fixture());assert.equal(result.claim_ids[0],'claim');assert.equal(db.claims[0].value_json.financial_document.original_scale,'MIL');assert.equal(db.claims[0].value_json.financial_document.period_start,'2025-01-01');assert.match(db.claims[0].value_text,/consolidado/);assert.match(financialValueText(fixture().facts[0]),/DFP v1/);
 const fail=database({failure:'claim_evidence'});await assert.rejects(persistDfpFacts(fail,ctx,fixture()),/support/);assert.ok(!fail.writes.some(w=>w.table==='claims'&&w.operation==='update'));
});
test('DFP não reporta como verificada uma reapresentação que o trigger colocou em revisão',async()=>{
 const db=database({claimStatus:'NONE',afterTriggerStatus:'CONTRADICTED'}),result=await persistDfpFacts(db,ctx,fixture());assert.equal(result.claim_ids.length,0);assert.equal(result.review_required,1);
});
test('endpoint DFP valida sessão, papel, organização e vínculo antes de consulta/gravação',async()=>{
 let handler,user={id:'u'},role='OWNER',foreign=false,link='SUPPORTED',queries=0,writes=0;
 const db={auth:{getUser:async()=>({data:{user}})},from(table){let operation='read';const q={};for(const m of ['select','eq','single','maybeSingle'])q[m]=()=>q;q.insert=()=>{operation='insert';return q};q.then=resolve=>Promise.resolve({data:operation!=='read'?(writes++,null):table==='profiles'?{active_organization_id:'org'}:table==='organization_members'?{role,status:'ACTIVE'}:table==='lead_company_links'?{status:link}:table==='source_registry'?{id:'source',connection_status:'CONNECTED'}:foreign?null:{id:'id',cnpj:CNPJ},error:null}).then(resolve);return q}};
 const source=fs.readFileSync(new URL('../supabase/functions/cvm-financial-statements/index.ts',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'');
 vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText,{Deno:{env:{get:()=>''},serve:f=>{handler=f}},createClient:()=>db,fetchDfpFinancials:async()=>{queries++;return {...fixture(),complete:true}},normalizeCnpj:v=>v,persistDfpFacts:async()=>({claim_ids:['claim'],review_required:0}),Response,Request,Date,Promise});
 const request=(auth=true)=>new Request('https://qa.test',{method:'POST',headers:auth?{Authorization:'Bearer qa'}:{},body:JSON.stringify({lead_id:'lead',company_id:'company',year:2025})});
 assert.equal((await handler(request(false))).status,401);user=null;assert.equal((await handler(request())).status,401);user={id:'u'};role='VIEWER';assert.equal((await handler(request())).status,403);role='OWNER';foreign=true;assert.equal((await handler(request())).status,404);foreign=false;link='REJECTED';assert.equal((await handler(request())).status,409);assert.equal(queries,0);assert.equal(writes,0);
 link='SUPPORTED';assert.equal((await handler(request())).status,200);assert.equal(queries,1);assert.equal(writes,1);
});
