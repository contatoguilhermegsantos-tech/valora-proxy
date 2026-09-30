import test from 'node:test';import assert from 'node:assert/strict';
import {buildCompanyPassport} from '../lib/company-passport.ts';
import {sourceBatches} from '../supabase/functions/_shared/source-batches.ts';
import {insertEvidenceOnce} from '../supabase/functions/_shared/connector-policy.ts';
const company={id:'c',cnpj:'32901144000105'};
const evidence={id:'e',company_id:'c',verification_status:'VERIFIED',retrieved_at:'2026-09-30T12:00:00Z'};
const fact={id:'f',company_id:'c',status:'VERIFIED',classification:'FACT',predicate:'cnae',value_text:'Saúde',claim_evidence:[{evidence_id:'e',support_type:'SUPPORTS'}]};
test('perfil isola empresa, exige apoio e expõe lacunas sem inventar finanças',()=>{
 const d={evidence:[evidence],claims:[fact,{...fact,id:'other',company_id:'foreign'}],events:[{company_id:'foreign',status:'VERIFIED',event_evidence:[{evidence_id:'e'}]}]};const p=buildCompanyPassport(d,company);
 assert.equal(p.sections.find(s=>s.key==='operation').items.length,1);assert.equal(p.sections.find(s=>s.key==='financial').items.length,0);assert.equal(p.sections.find(s=>s.key==='events').items.length,0);assert.equal(p.lastConsulted,evidence.retrieved_at);
});
test('fonte rejeitada ou contraditória retira conteúdo do passaporte',()=>{
 const d={evidence:[{...evidence,verification_status:'REJECTED'}],claims:[fact]};assert.equal(buildCompanyPassport(d,company).sections[1].items.length,0);
 d.evidence=[evidence];d.claims=[{...fact,claim_evidence:[...fact.claim_evidence,{evidence_id:'e',support_type:'CONTRADICTS'}]}];assert.equal(buildCompanyPassport(d,company).sections[1].items.length,0);
});
test('capital social não preenche dimensão financeira; administrador não vira decisor confirmado',()=>{
 const d={evidence:[evidence],claims:[{...fact,predicate:'registered_capital',value_text:'1000'}],relationships:[{id:'r',from_entity_type:'COMPANY',from_entity_id:'c',relationship_type:'ADMINISTRADOR',to_label:'Pessoa',status:'SUPPORTED',relationship_evidence:[{evidence_id:'e'}]}]};const p=buildCompanyPassport(d,company);
 assert.equal(p.sections.find(s=>s.key==='financial').items.length,0);assert.equal(p.capital.length,1);assert.equal(p.sections.find(s=>s.key==='decision').items[0].provisional,true);
});
test('lotes limitam linhas e bytes reais, sem perder registros; item enorme falha explicitamente',()=>{
 const rows=Array.from({length:45},(_,i)=>({id:i,text:'á'.repeat(1500)})),batches=sourceBatches(rows);
 assert.deepEqual(batches.flat(),rows);assert.ok(batches.every(b=>b.length<=20&&new TextEncoder().encode(JSON.stringify(b)).length<=32768));assert.throws(()=>sourceBatches([{text:'x'.repeat(40000)}]),/exceeds/);
});
test('reconsulta usa ignoreDuplicates e mantém evidência rejeitada',async()=>{
 let options;const db={from(){const q={upsert(p,o){options=o;return Promise.resolve({error:null})},select(){return q},eq(){return q},single(){return Promise.resolve({data:{id:'e',verification_status:'REJECTED'},error:null})}};return q}};
 const r=await insertEvidenceOnce(db,{organization_id:'o',lead_id:'l',dedupe_key:'l:source',verification_status:'VERIFIED'});assert.equal(options.ignoreDuplicates,true);assert.equal(r.verification_status,'REJECTED');
});
