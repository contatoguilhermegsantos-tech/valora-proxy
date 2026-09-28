import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveCompanyCnpj,nodeLeadId} from '../supabase/functions/_shared/company-context.ts';
import {buildCommercialBrief} from '../lib/commercial-brief.ts';
test('núcleo antigo recupera CNPJ único, sem atribuí-lo a uma pessoa',()=>{
 const links=[{status:'SUPPORTED',companies:{cnpj:'32.901.144/0001-05'}}];
 assert.equal(resolveCompanyCnpj({kind:'COMPANY'},null,links),'32901144000105');
 assert.equal(resolveCompanyCnpj({kind:'PERSON'},null,links),'');
 assert.equal(resolveCompanyCnpj({kind:'COMPANY'},null,[{...links[0],status:'REJECTED'}]),'');
 assert.throws(()=>resolveCompanyCnpj({kind:'COMPANY'},null,[...links,{status:'VERIFIED',companies:{cnpj:'33000167000101'}}]));
 assert.throws(()=>resolveCompanyCnpj({kind:'COMPANY'},'123',links));
});
test('reabertura converge no mesmo núcleo, organizações e entidades permanecem separadas',async()=>{
 const first=await nodeLeadId('org','PERSON','person');assert.equal(first,await nodeLeadId('org','PERSON','person'));
 assert.notEqual(first,await nodeLeadId('other','PERSON','person'));assert.notEqual(first,await nodeLeadId('org','PERSON','homonym'));
});
test('temas comerciais exigem evidência verificada e desaparecem se ela for rejeitada',()=>{
 const d={companies:[{id:'c',legal_name:'Empresa',link_status:'SUPPORTED'}],claims:[{id:'f',company_id:'c',classification:'FACT',status:'VERIFIED',predicate:'cnae',value_text:'Serviços',claim_evidence:[{evidence_id:'e'}]}],evidence:[{id:'e',verification_status:'VERIFIED'}]};
 assert.equal(buildCommercialBrief(d).topics.length,1);
 d.evidence[0].verification_status='REJECTED';assert.equal(buildCommercialBrief(d).topics.length,0);
});
test('sinal com suporte contradito não entra na preparação comercial',()=>{
 const d={evidence:[{id:'e',verification_status:'VERIFIED'}],signals:[{title:'Teste',status:'ACTIVE',evidence_ids:['e'],claim_ids:['rejected'],event_ids:[]}]};
 assert.equal(buildCommercialBrief(d).topics.length,0);
});
test('empresa no grafo não perde o status do vínculo confirmado no resumo',()=>{
 const d={companies:[{id:'c',link_status:'VERIFIED'}],extra_companies:[{id:'c'}]};
 assert.equal(buildCommercialBrief(d).companies[0].link_status,'VERIFIED');
 d.companies[0].link_status='REJECTED';assert.equal(buildCommercialBrief(d).companies.length,0);
});

