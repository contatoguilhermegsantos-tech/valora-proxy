import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchSourceJson,selectTerritory,searchOutcome,summarizeSourceHealth,summarizeQualityRun,advanceCoverage} from '../supabase/functions/_shared/source-operations.ts';

test('município exige nome exato e UF; homônimos não escolhem a primeira cidade',()=>{
 const cities=[{territory_id:'1',territory_name:'São João',state_code:'SP'},{territory_id:'2',territory_name:'São João',state_code:'PR'}];
 assert.equal(selectTerritory(cities,'Sao Joao','SP').city.territory_id,'1');
 assert.equal(selectTerritory(cities,'Sao Joao','RJ').city,null);
 assert.equal(selectTerritory(cities,'Sao Joao','').ambiguous,true);
 assert.equal(selectTerritory(cities,'Sao','SP').city,null);
});
test('falha transitória retenta uma vez; indisponibilidade não vira vazio',async()=>{
 let calls=0;
 const r=await fetchSourceJson('https://source.test',Array.isArray,{fetcher:async()=>{calls++;return new Response('unavailable',{status:503})},wait:async()=>{}});
 assert.equal(calls,2);assert.equal(r.ok,false);assert.equal(r.status,503);assert.equal(r.data,null);
});
test('429 com espera longa não causa rajada; autenticação não é retentada',async()=>{
 for(const status of [429,401,403]){
  let calls=0;
  const r=await fetchSourceJson('https://source.test',Array.isArray,{fetcher:async()=>{calls++;return new Response('',{status,headers:{'Retry-After':'60'}})},wait:async()=>{}});
  assert.equal(calls,1);assert.equal(r.ok,false);
 }
});
test('JSON vazio, truncado ou contrato incompatível nunca confirma zero resultados',async()=>{
 for(const body of ['','{','{}']){
  const r=await fetchSourceJson('https://source.test',Array.isArray,{fetcher:async()=>new Response(body),wait:async()=>{}});
  assert.equal(r.ok,false);assert.equal(r.error,'INVALID_RESPONSE');
 }
 const r=await fetchSourceJson('https://source.test',Array.isArray,{fetcher:async()=>new Response('[]')});
 assert.equal(r.ok,true);assert.deepEqual(r.data,[]);
});
test('timeout e erro de rede são limitados; recuperação preserva resposta válida',async()=>{
 let calls=0;
 const r=await fetchSourceJson('https://source.test',Array.isArray,{fetcher:async()=>{if(!calls++)throw new DOMException('deadline','TimeoutError');return new Response('[]')},wait:async()=>{}});
 assert.equal(calls,2);assert.equal(r.ok,true);
 const failed=await fetchSourceJson('https://source.test',Array.isArray,{fetcher:async()=>{throw new TypeError('network')},wait:async()=>{}});
 assert.equal(failed.error,'NETWORK_ERROR');
});
test('busca parcial e falha total não recebem rótulo de ausência de menções',()=>{
 assert.equal(searchOutcome(0,4,0),'QUERY_FAILED');assert.equal(searchOutcome(1,3,0),'PARTIAL');
 assert.equal(searchOutcome(1,0,0),'NO_MENTIONS');assert.equal(searchOutcome(1,0,2),'MENTIONS_FOUND');
});
test('saúde distingue registros legados inconclusivos e cobertura confirmada',()=>{
 const logs=[{source_registry_id:'a',queried_at:'2026-09-29',result_status:'CITY_NOT_COVERED',success:false},{source_registry_id:'b',queried_at:'2026-09-29',result_status:'CITY_LOOKUP_FAILED',success:false},{source_registry_id:'c',queried_at:'2026-09-29',result_status:'CITY_NOT_COVERED_CONFIRMED',success:true}];
 const health=summarizeSourceHealth(logs);
 assert.equal(health[0].health,'INCONCLUSIVE');assert.equal(health[0].failures,0);
 assert.equal(health[1].health,'FAILURE');assert.equal(health[1].failures,1);
 assert.equal(health[2].health,'CONTEXT_REQUIRED');assert.deepEqual(summarizeSourceHealth([]),[]);
});
test('cobertura PNCP só avança por datas contíguas; reparar lacuna recupera datas seguintes',()=>{
 const dates=[{target_date:'2026-09-28',status:'FAILED'},{target_date:'2026-09-29',status:'DONE'}];
 assert.equal(advanceCoverage('2026-09-27',dates),'2026-09-27');
 dates[0].status='DONE';assert.equal(advanceCoverage('2026-09-27',dates),'2026-09-29');
 assert.equal(advanceCoverage('2026-09-26',dates),'2026-09-26');
});

test('falha na consulta da autoauditoria não vira violação medida nem expõe o erro privado',()=>{
 const quality=summarizeQualityRun({status:'FAIL',critical_count:1,warning_count:0,finished_at:'2026-10-07T00:00:00Z',snapshot:{error:'PRIVATE_QUERY_ERROR',secret:'PRIVATE_SNAPSHOT'}});
 assert.equal(quality.completed,false);assert.equal(quality.error_code,'AUDIT_QUERY_FAILED');
 assert.equal(quality.critical_count,null);assert.equal(quality.warning_count,null);
 assert.doesNotMatch(JSON.stringify(quality),/PRIVATE|snapshot/);
});

test('autoauditoria concluída preserva violações reais e alertas',()=>{
 const quality=summarizeQualityRun({status:'FAIL',critical_count:2,warning_count:1,finished_at:'2026-10-07T00:00:00Z',snapshot:{metrics:{invalid_lead_cnpjs:2,stuck_research_runs:1}}});
 assert.equal(quality.completed,true);assert.equal(quality.error_code,null);
 assert.equal(quality.critical_count,2);assert.equal(quality.warning_count,1);
 assert.equal('snapshot' in quality,false);
});

test('autoauditoria sem execução permanece ausente; PASS e histórico sem snapshot mantêm o contrato',()=>{
 assert.equal(summarizeQualityRun(null),null);
 for(const snapshot of [undefined,null,{metrics:{}}]){
  const quality=summarizeQualityRun({status:'PASS',critical_count:0,warning_count:0,finished_at:'2026-10-07T00:00:00Z',snapshot});
  assert.equal(quality.completed,true);assert.equal(quality.status,'PASS');assert.equal(quality.critical_count,0);
 }
});
