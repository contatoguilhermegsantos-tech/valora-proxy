import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyWebResult,collectSourcePages} from '../supabase/functions/_shared/connector-policy.ts';
import {buildCommercialBrief} from '../lib/commercial-brief.ts';
test('domínios parecidos não ganham autoridade de fonte oficial ou imprensa',()=>{
 assert.equal(classifyWebResult('gov.br.evil.test','',''),'WEB_CANDIDATE');
 assert.equal(classifyWebResult('reuters.com.evil.test','',''),'WEB_CANDIDATE');
 assert.equal(classifyWebResult('www.gov.br','',''),'OFFICIAL_GOV');
});
test('limite de páginas preserva achados sem afirmar consulta completa',async()=>{
 let requests=0;const r=await collectSourcePages('https://example.test/data',{'chave-api-dados':'test-only'},2,async(url,options)=>{requests++;assert.equal(options.headers['chave-api-dados'],'test-only');return new Response(JSON.stringify([{id:requests}]),{status:200});});
 assert.equal(r.complete,false);assert.equal(r.rows.length,2);assert.equal(requests,2);
});
test('resposta vazia válida conclui; conteúdo incompatível continua inconclusivo',async()=>{
 const empty=await collectSourcePages('https://example.test/data',{},2,async()=>new Response('[]'));
 assert.equal(empty.complete,true);
 const invalid=await collectSourcePages('https://example.test/data',{},2,async()=>new Response('{}'));
 assert.equal(invalid.complete,false);assert.equal(invalid.ok,false);
});
test('documento que contradiz um fato não sustenta preparação comercial',()=>{
 const d={companies:[{id:'c'}],evidence:[{id:'e',verification_status:'VERIFIED'}],claims:[{id:'f',company_id:'c',status:'VERIFIED',classification:'FACT',predicate:'cnae',claim_evidence:[{evidence_id:'e',support_type:'CONTRADICTS'}]}]};
 assert.equal(buildCommercialBrief(d).facts.length,0);assert.equal(buildCommercialBrief(d).topics.length,0);
});
