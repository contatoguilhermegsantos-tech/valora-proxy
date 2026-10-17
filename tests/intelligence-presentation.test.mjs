import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';

const require=createRequire(new URL('../package.json',import.meta.url));
const ts=require('typescript'),React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
const testsBase=new URL('./research-workspace-ui.test.mjs',import.meta.url);
let harness=fs.readFileSync(testsBase,'utf8');
harness=harness.slice(harness.indexOf('const leadId='),harness.indexOf('\nawait test(')).replaceAll('import.meta.url','testsBase');
const context={require,fs,vm,ts,React,renderToStaticMarkup,testsBase,URL,URLSearchParams,Date,Set,Map,console,setTimeout,clearTimeout,setImmediate};
vm.runInNewContext(harness+'\nglobalThis.harness={uiFixture,find,button,dossier,leadId,orgId};',context);
const {uiFixture,find,button,dossier,leadId,orgId}=context.harness;
function compile(relative,overrides={}){
 const file=new URL(relative,import.meta.url),module={exports:{}};
 const customRequire=id=>{
  if(overrides[id])return overrides[id];
  if(id.startsWith('.'))return compile(new URL(id+'.ts',file).href);
  return require(id);
 };
 const output=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 vm.runInNewContext(output,{module,exports:module.exports,require:customRequire,Date,Map,Set,console});return module.exports;
}
const evidence={id:'e',organization_id:orgId,lead_id:leadId,verification_status:'VERIFIED',source_url:'https://example.org/document'};
const company={id:'company',legal_name:'Empresa QA',link_status:'VERIFIED'};
const claim={id:'claim',company_id:company.id,subject_label:company.legal_name,predicate:'revenue',value_text:'Receita histórica QA; exercício 2025',classification:'FACT',status:'VERIFIED',claim_evidence:[{evidence_id:evidence.id,support_type:'SUPPORTS'}]};
async function tab(data,label){const f=uiFixture({initialDossier:dossier(data)});await f.settle();button(f.tree,label).props.onClick();await f.settle();return f;}

test('Factual validation and its metric require current scoped VERIFIED SUPPORTS and no contradiction',async()=>{
 for(const [doc,refs] of [
  [{...evidence,verification_status:'FAILED'},claim.claim_evidence],
  [{...evidence,verification_status:'STALE'},claim.claim_evidence],
  [{...evidence,organization_id:'other-org'},claim.claim_evidence],
  [{...evidence,lead_id:'other-lead'},claim.claim_evidence],
  [evidence,[{evidence_id:'e'}]],
  [evidence,[...claim.claim_evidence,{evidence_id:'e',support_type:'CONTRADICTS'}]],
 ]){
  const f=await tab({companies:[company],claims:[{...claim,claim_evidence:refs}],evidence:[doc]},'Validação');
  assert.equal(f.html().includes(claim.value_text),false);assert.match(f.html(),/Ainda não há fatos verificados suficientes/);f.dispose();
 }
 const f=await tab({companies:[company],claims:[claim],evidence:[evidence]},'Validação');assert.match(f.html(),/Receita histórica QA/);f.dispose();
});

test('Signals lose presentation when their document or any referenced fact/event is not currently supported',async()=>{
 const signal={id:'signal',status:'ACTIVE',classification:'INDICATION',confidence:'HIGH',title:'Sinal específico QA',summary:'Pergunta para validar',evidence_ids:['e'],claim_ids:['claim'],event_ids:[]};
 for(const patch of [
  {evidence:[{...evidence,verification_status:'FAILED'}]},
  {evidence:[{...evidence,lead_id:'other-lead'}]},
  {claims:[{...claim,status:'CONTRADICTED'}]},
  {claims:[{...claim,claim_evidence:[{evidence_id:'e'}]}]},
  {signals:[{...signal,event_ids:['missing-event']}]},
  {signals:[{...signal,status:'STALE'}]},
  {signals:[{...signal,claim_ids:[],event_ids:[]}]},
 ]){
  const f=await tab({companies:[company],claims:[claim],evidence:[evidence],signals:[signal],...patch},'Sinais consultivos');
  assert.equal(f.html().includes(signal.title),false);assert.match(f.html(),/sem suporte vigente|suporte documental vigente/);f.dispose();
 }
 const f=await tab({claims:[claim],evidence:[evidence],signals:[signal]},'Sinais consultivos');assert.match(f.html(),/Sinal específico QA/);assert.match(f.html(),/https:\/\/example.org\/document/);f.dispose();
 const event={id:'event',status:'VERIFIED',classification:'FACT',event_evidence:[{evidence_id:'e',support_type:'SUPPORTS'}]};
 const byEvent=await tab({events:[event],evidence:[evidence],signals:[{...signal,claim_ids:[],event_ids:['event']}]},'Sinais consultivos');assert.match(byEvent.html(),/Sinal específico QA/);byEvent.dispose();
});

test('Page does not grant graph expansion to contradicted, unsupported or foreign-document relationships',async()=>{
 const base={from_entity_type:'LEAD',from_entity_id:leadId,to_entity_type:'COMPANY',to_entity_id:company.id,classification:'FACT',status:'VERIFIED',relationship_evidence:[{evidence_id:'e',support_type:'SUPPORTS'}]};
 const relationships=[{...base,id:'live'},{...base,id:'conflict',status:'CONTRADICTED'},{...base,id:'reviewed',relationship_evidence:[{evidence_id:'failed',support_type:'SUPPORTS'}]},{...base,id:'foreign',relationship_evidence:[{evidence_id:'foreign',support_type:'SUPPORTS'}]}];
 const f=await tab({relationships,evidence:[evidence,{...evidence,id:'failed',verification_status:'FAILED'},{...evidence,id:'foreign',lead_id:'other-lead'}]},'Relações');
 const graph=find(f.tree,node=>node.type===f.components.RelationshipGraph);assert.ok(graph);assert.deepEqual(Array.from(graph.props.expandableRelationshipIds),['live']);assert.equal(graph.props.relationships.some(r=>r.id==='conflict'),true);f.dispose();
});

test('Contradicted graph edges remain explicit for review and cannot expand even if an id is offered',()=>{
 const hooks={...React,useMemo:fn=>fn(),useState:value=>[value,()=>{}]};
 const {RelationshipGraph}=compile('../components/RelationshipGraph.tsx',{'react':hooks,'@/lib/supabase':{supabaseBrowser:()=>{throw new Error('No source or API calls during rendering')}}});
 const relationship={id:'r',from_entity_type:'LEAD',from_entity_id:leadId,from_label:'Lead QA',to_entity_type:'COMPANY',to_entity_id:'company',to_label:'Empresa QA',relationship_type:'BUSINESS_LINK',classification:'INDICATION',confidence:'LOW',status:'CONTRADICTED'};
 const html=renderToStaticMarkup(React.createElement(RelationshipGraph,{leadId,leadName:'Lead QA',relationships:[relationship],expandableRelationshipIds:['r']}));
 assert.match(html,/Em conflito; revisar/);assert.match(html,/stroke-dasharray:6 5/);assert.match(html,/expansão bloqueada/);assert.equal(html.includes('Expandir este núcleo'),false);
 const valid=renderToStaticMarkup(React.createElement(RelationshipGraph,{leadId,leadName:'Lead QA',relationships:[{...relationship,status:'VERIFIED'}],expandableRelationshipIds:['r']}));assert.match(valid,/Documentada/);assert.match(valid,/Expandir este núcleo/);
});

test('Two roles for one participant do not create a multiple-participant governance or succession thesis',()=>{
 const {buildCommercialOpportunities}=compile('../lib/commercial-opportunities.ts');
 const relation={from_entity_type:'COMPANY',from_entity_id:company.id,to_entity_type:'PERSON',to_entity_id:'person',to_label:'Ana QA',classification:'FACT',status:'VERIFIED',relationship_evidence:[{evidence_id:'e',support_type:'SUPPORTS'}]};
 const relationships=[{...relation,id:'socio',relationship_type:'SOCIO',reason:'Consta no QSA como Sócio (pessoa física)'},{...relation,id:'admin',relationship_type:'ADMINISTRADOR',reason:'Consta no QSA como Administrador (pessoa física)'}];
 const run=rows=>buildCommercialOpportunities({companies:[company],evidence:[evidence],relationships:rows});
 assert.equal(run(relationships).length,0);
 assert.equal(run(relationships.map(r=>({...r,to_entity_id:null,to_label:r.id==='socio'?' Ana  QA ':'ANA QA'}))).length,0);
 assert.equal(run([relationships[0],{...relationships[1],to_entity_id:'different-person'}]).length,2);
});
