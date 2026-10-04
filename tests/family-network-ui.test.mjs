import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {webcrypto} from 'node:crypto';
const require=createRequire(new URL('../package.json',import.meta.url));
const ts=require('typescript'),React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
const source=fs.readFileSync(new URL('../components/FamilyNetworkGraph.tsx',import.meta.url),'utf8');
let stateIndex=0,selected='C:company1';
const module={exports:{}};
const customRequire=id=>id==='next/navigation'?{useRouter:()=>({push(){}})}:id==='@/lib/supabase'?{supabaseBrowser:()=>{throw Error('No network allowed in rendering QA')}}:id==='react'?{...React,useState:initial=>React.useState(stateIndex++===6?selected:initial)}:require(id);
const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}});
assert.equal((compiled.diagnostics||[]).filter(d=>d.category===ts.DiagnosticCategory.Error).length,0);
vm.runInNewContext(compiled.outputText+'\nexports.__qa={cleanGraph,connectionPath,halted,httpsUrl};',{module,exports:module.exports,require:customRequire,crypto:webcrypto,URL,Date,Set,Map,console});
const {FamilyNetworkGraph,__qa:q}=module.exports;
const ids={org:'10000000-0000-4000-8000-000000000001',lead:'20000000-0000-4000-8000-000000000001',source:'30000000-0000-4000-8000-000000000001',evidence:'40000000-0000-4000-8000-000000000001',pivot:'50000000-0000-4000-8000-000000000001',c1:'60000000-0000-4000-8000-000000000001',p1:'60000000-0000-4000-8000-000000000002',p2:'60000000-0000-4000-8000-000000000003',c2:'60000000-0000-4000-8000-000000000004',foreign:'60000000-0000-4000-8000-000000000005'};
const flags={identity_confirmed:false,kinship_confirmed:false};
const graph={revision:3,status:'PARTIAL',continuation:true,nodes:[{key:'root',type:'ROOT',label:'Lead atual',depth:0,...flags},{key:'C:company1',type:'COMPANY',label:'Empresa A',full_cnpj:'11111111000191',candidate_id:ids.c1,evidence_id:ids.evidence,depth:1,...flags},{key:'P:occurrence1',type:'PERSON_CITATION',label:'Mesma Pessoa',person_name:'Mesma Pessoa',full_cnpj:'11111111000191',candidate_id:ids.p1,evidence_id:ids.evidence,depth:1,...flags},{key:'P:occurrence2',type:'PERSON_CITATION',label:'Mesma Pessoa',person_name:'Mesma Pessoa',full_cnpj:'22222222000191',candidate_id:ids.p2,evidence_id:ids.evidence,depth:2,...flags},{key:'C:company2',type:'COMPANY',label:'Empresa B',full_cnpj:'22222222000191',candidate_id:ids.c2,evidence_id:ids.evidence,depth:2,...flags}],edges:[{id:'edge-root',from:'root',to:'C:company1',kind:'ROOT_CONTEXT_CANDIDATE',evidence_id:ids.evidence},{id:'edge-qsa1',from:'C:company1',to:'P:occurrence1',kind:'QSA_PARTICIPATION',evidence_id:ids.evidence},{id:'edge-name',from:'P:occurrence1',to:'P:occurrence2',kind:'SAME_NAME_CANDIDATE',evidence_id:ids.evidence},{id:'edge-qsa2',from:'C:company2',to:'P:occurrence2',kind:'QSA_PARTICIPATION',evidence_id:ids.evidence}]};
const row=(id,type,metadata)=>({id,organization_id:ids.org,lead_id:ids.lead,entity_type:type,confidence:'LOW',validation_status:'UNVALIDATED',candidate_type:type==='PERSON'?'FAMILY_NETWORK_PERSON':'FAMILY_NETWORK_COMPANY',metadata:{...flags,evidence_id:ids.evidence,...metadata}});
const dossier={role:'OWNER',lead:{id:ids.lead,organization_id:ids.org,kind:'PERSON',name:'Lead atual'},evidence:[{id:ids.evidence,organization_id:ids.org,lead_id:ids.lead,verification_status:'VERIFIED',source_registry_id:ids.source,source_url:'https://example.com/public-source',title:'Nome no QSA'}],candidates:[row(ids.c1,'COMPANY',{company_name:'Empresa A',full_cnpj:'11111111000191'}),row(ids.p1,'PERSON',{person_name:'Mesma Pessoa',match_basis:'QSA_PERSON'}),row(ids.p2,'PERSON',{person_name:'Mesma Pessoa',match_basis:'QSA_PERSON'}),row(ids.c2,'COMPANY',{company_name:'Empresa B',full_cnpj:'22222222000191'}),{id:ids.pivot,organization_id:ids.org,lead_id:ids.lead,candidate_type:'FAMILY_NETWORK_PIVOT',validation_status:'UNVALIDATED',metadata:{revision:3,public_graph:graph}}]};
let passes=0;
function render(d=dossier,key='C:company1'){stateIndex=0;selected=key;return renderToStaticMarkup(React.createElement(FamilyNetworkGraph,{dossier:d,onUpdated:async()=>{}}))}
const opening=html=>html.match(/<button[^>]*>Investigar separadamente<\/button>/)?.[0]||'';
test('Same full name retains two occurrence keys',()=>{const clean=q.cleanGraph(graph,dossier.candidates,'Lead atual');assert.equal(clean.nodes.filter(n=>n.label==='Mesma Pessoa').length,2);assert.notEqual(clean.nodes[2].key,clean.nodes[3].key)});
test('Same-name QSA buttons identify their distinct company CNPJs visually and accessibly',()=>{
 const html=render(dossier,'P:occurrence1');
 const buttons=[...html.matchAll(/<button[^>]*aria-label="Nome citado no QSA:[^"]*"[^>]*>[\s\S]*?<\/button>/g)].map(match=>match[0]);
 assert.equal(buttons.length,2);
 for(const full of ['11111111000191','22222222000191']){
  const button=buttons.find(value=>value.includes(`aria-label="Nome citado no QSA: Mesma Pessoa. QSA do CNPJ ${full}. Selecionar caminho e documentos."`));
  assert.ok(button);assert.match(button,new RegExp(`>QSA do CNPJ ${full}<`));assert.match(button,/Identidade individual não confirmada/);
 }
 assert.notEqual(buttons[0].match(/aria-label="([^"]*)"/)[1],buttons[1].match(/aria-label="([^"]*)"/)[1]);
});
test('Weighted path is deterministic despite shuffled edges',()=>{const a=q.connectionPath(graph.nodes,graph.edges,'C:company2'),b=q.connectionPath(graph.nodes,[...graph.edges].reverse(),'C:company2');assert.equal(JSON.stringify(a),JSON.stringify(b));assert.equal(a.nodes.join(','),'root,C:company1,P:occurrence1,P:occurrence2,C:company2')});
test('Documented Julio route outranks a shorter surname shortcut without changing confidence',()=>{
 const nodes=[{key:'root',type:'ROOT'}, {key:'agro',type:'COMPANY'}, {key:'julio',type:'PERSON_CITATION'}, {key:'market',type:'COMPANY'}, {key:'jacira',type:'PERSON_CITATION'}];
 const edges=[{id:'weak-shortcut',from:'root',to:'market',kind:'SURNAME_CONTEXT_CANDIDATE'}, {id:'seed',from:'root',to:'agro',kind:'ROOT_CONTEXT_CANDIDATE',match_basis:'SEED_CNPJ_OBSERVED'}, {id:'julio-qsa',from:'agro',to:'julio',kind:'QSA_PARTICIPATION'}, {id:'julio-name',from:'julio',to:'market',kind:'ROOT_CONTEXT_CANDIDATE',match_basis:'QSA_EXACT_NAME'}, {id:'jacira-qsa',from:'market',to:'jacira',kind:'QSA_PARTICIPATION'}].map(edge=>({...edge,validation_status:'UNVALIDATED',confidence:'LOW',...flags}));
 const unchanged=JSON.stringify(edges),path=q.connectionPath(nodes,edges,'jacira');
 assert.equal(path.nodes.join(','),'root,agro,julio,market,jacira');assert.equal(path.edges.join(','),'seed,julio-qsa,julio-name,jacira-qsa');
 assert.equal(JSON.stringify(q.connectionPath(nodes,[...edges].reverse(),'jacira')),JSON.stringify(path));assert.equal(JSON.stringify(edges),unchanged);
});
test('Exact context and same-name costs beat weak context and ties have stable ordering',()=>{
 const nodes=[{key:'root',type:'ROOT'},{key:'a',type:'PERSON_CITATION'},{key:'b',type:'PERSON_CITATION'},{key:'target',type:'COMPANY'}];
 for(const match_basis of ['QSA_EXACT_NAME','LEGAL_NAME_EXACT_PERSON_NAME','EXACT_LEAD_NAME_PENDING_IDENTITY']){
  const edges=[{id:'weak',from:'root',to:'target',kind:'ROOT_CONTEXT_CANDIDATE',match_basis:'SURNAME_CITY_ONLY'},{id:'a-start',from:'root',to:'a',kind:'ROOT_CONTEXT_CANDIDATE',match_basis},{id:'a-end',from:'a',to:'target',kind:'SAME_NAME_CANDIDATE'},{id:'b-start',from:'root',to:'b',kind:'ROOT_CONTEXT_CANDIDATE',match_basis},{id:'b-end',from:'b',to:'target',kind:'SAME_NAME_CANDIDATE'}];
  assert.equal(q.connectionPath(nodes,edges,'target').nodes.join(','),'root,a,target');assert.equal(q.connectionPath(nodes,[...edges].reverse(),'target').nodes.join(','),'root,a,target');
 }
});
test('Rejected citation removes its node and incident edges',()=>{const clean=q.cleanGraph(graph,dossier.candidates.map(r=>r.id===ids.p1?{...r,validation_status:'REJECTED'}:r),'Lead atual');assert.equal(clean.nodes.some(n=>n.key==='P:occurrence1'),false);assert.equal(clean.edges.some(e=>e.from==='P:occurrence1'||e.to==='P:occurrence1'),false)});
test('Foreign candidate reference is not rendered',()=>{const poisoned={...graph,nodes:[...graph.nodes,{key:'foreign',type:'PERSON_CITATION',label:'Foreign secret',candidate_id:ids.foreign,depth:1,...flags}]};const copy=structuredClone(dossier);copy.candidates.at(-1).metadata.public_graph=poisoned;copy.candidates.push({...row(ids.foreign,'PERSON',{person_name:'Foreign secret'}),organization_id:'other-org'});assert.equal(render(copy).includes('Foreign secret'),false)});
test('Verified own-scope company enables independent opening',()=>{assert.match(opening(render()),/^<button/);assert.equal(opening(render()).includes('disabled'),false)});
test('Viewer cannot open or expand',()=>{const html=render({...dossier,role:'VIEWER'});assert.equal(opening(html).includes('disabled'),true);assert.match(html,/<button[^>]*disabled=""[^>]*>Continuar expansão<\/button>/)});
test('Unverified or foreign-lead document blocks opening',()=>{for(const document of [{...dossier.evidence[0],verification_status:'FAILED'},{...dossier.evidence[0],lead_id:'other-lead'}])assert.equal(opening(render({...dossier,evidence:[document]})).includes('disabled'),true)});
test('Rejected ancestor disconnects descendant and blocks opening',()=>{const copy=structuredClone(dossier);copy.candidates[1].validation_status='REJECTED';const html=render(copy,'C:company2');assert.match(html,/Não há caminho ativo/);assert.equal(opening(html).includes('disabled'),true)});
test('Citation label and same-name edge remain cautious',()=>{const html=render(dossier,'P:occurrence1');assert.match(html,/Mesmo nome · hipótese/);assert.match(html,/Nome documentado no QSA/);assert.match(html,/Identidade individual não confirmada/)});
test('Nested persisted cooldown and stalled cursor stop expansion',()=>{assert.equal(q.halted({status:'PARTIAL',pivot:{metadata:{state:{retry_not_before:new Date(Date.now()+60000).toISOString()}}}}),true);assert.equal(q.halted({status:'PARTIAL',pivot:{metadata:{state:{pagination_stalled:true}}}}),true);assert.equal(q.halted({status:'PARTIAL',continuation:true,pivot:{metadata:{state:{}}}}),false)});
test('Source links require HTTPS without credentials',()=>{assert.equal(q.httpsUrl('javascript:alert(1)'),null);assert.equal(q.httpsUrl('http://example.com'),null);assert.equal(q.httpsUrl('https://user:password@example.com'),null);assert.equal(q.httpsUrl('https://example.com/source'),'https://example.com/source')});
test('Company dossier does not render family widget',()=>{assert.equal(render({...dossier,lead:{...dossier.lead,kind:'COMPANY'}}),'')});
function loopFixture(responder){
 const effects=[],states=new Map(),loopModule={exports:{}};let hook=0,calls=0;
 const mockedReact={useRef:value=>({current:value}),useMemo:callback=>callback(),useState:initial=>{const id=hook++,value=id===1?true:initial;states.set(id,value);return[value,next=>states.set(id,typeof next==='function'?next(states.get(id)):next)]},useEffect:callback=>effects.push(callback)};
 const loopRequire=id=>id==='react'?mockedReact:id==='next/navigation'?{useRouter:()=>({push(){}})}:id==='@/lib/supabase'?{supabaseBrowser:()=>({functions:{invoke:async()=>responder(++calls)}})}:require(id);
 vm.runInNewContext(compiled.outputText,{module:loopModule,exports:loopModule.exports,require:loopRequire,crypto:webcrypto,URL,Date,Set,Map,console});
 const tree=loopModule.exports.FamilyNetworkGraph({dossier,onUpdated:async()=>{}});effects[0]();effects[1]();
 return{states,tree,get calls(){return calls}};
}
async function flush(){for(let i=0;i<80;i++)await new Promise(resolve=>setImmediate(resolve))}
function response(revision,continuation=true,state={}){return{data:{ok:true,status:'PARTIAL',continuation,network:{...graph,revision},pivot:{...dossier.candidates.at(-1),metadata:{revision,public_graph:{...graph,revision},state}}},error:null}}
await test('Automatic sequential expansion stops at 12 batches',async()=>{const f=loopFixture(call=>response(3+call));await flush();assert.equal(f.calls,12);assert.equal(f.states.get(1),false);assert.match(f.states.get(4),/12 etapas/)});
await test('Terminal continuation false stops after one call',async()=>{const f=loopFixture(()=>response(4,false));await flush();assert.equal(f.calls,1);assert.equal(f.states.get(1),false)});
await test('A repeated checkpoint stops instead of blindly querying again',async()=>{const f=loopFixture(()=>response(3));await flush();assert.equal(f.calls,1);assert.match(f.states.get(4),/não avançou/)});
await test('HTTP 429 stops and surfaces useful guidance',async()=>{const f=loopFixture(call=>call===1?response(4):{error:{context:{status:429}}});await flush();assert.equal(f.calls,2);assert.equal(f.states.get(5),true);assert.match(f.states.get(4),/limitou/)});
await test('Persisted cooldown stops a continuing response',async()=>{const f=loopFixture(()=>response(4,true,{retry_not_before:new Date(Date.now()+60000).toISOString()}));await flush();assert.equal(f.calls,1);assert.equal(f.states.get(1),false)});
function findButton(tree,label){if(!tree||typeof tree!=='object')return null;if(tree.type==='button'&&tree.props?.children===label)return tree;for(const child of [tree.props?.children].flat(Infinity)){const found=findButton(child,label);if(found)return found}return null}
await test('Pause allows current response to persist but schedules no next batch',async()=>{let release;const first=new Promise(resolve=>release=resolve),f=loopFixture(()=>first);assert.equal(f.calls,1);const pause=findButton(f.tree,'Pausar expansão');assert.ok(pause);pause.props.onClick();release(response(4));await flush();assert.equal(f.calls,1);assert.equal(f.states.get(1),false);assert.match(f.states.get(4),/pausada/)});
function visitFixture(input=dossier){
 const fixtureModule={exports:{}},states=new Map(),refs=new Map(),updates=[],timers=[],cancelled=[];let effects=[],stateHook=0,refHook=0,time=Date.now(),requests=0;
 class ControlledDate extends Date {static now(){return time}}
 const hooks={useRef:initial=>{const id=refHook++;if(!refs.has(id))refs.set(id,{current:initial});return refs.get(id)},useMemo:callback=>callback(),useState:initial=>{const id=stateHook++;if(!states.has(id))states.set(id,typeof initial==='function'?initial():initial);return[states.get(id),next=>{updates.push(id);states.set(id,typeof next==='function'?next(states.get(id)):next)}]},useEffect:callback=>effects.push(callback)};
 const visitRequire=id=>id==='react'?hooks:id==='next/navigation'?{useRouter:()=>({push(){}})}:id==='@/lib/supabase'?{supabaseBrowser:()=>({functions:{invoke:async()=>{requests++;throw Error('Unexpected network call')}}})}:require(id);
 vm.runInNewContext(compiled.outputText,{module:fixtureModule,exports:fixtureModule.exports,require:visitRequire,crypto:webcrypto,URL,Date:ControlledDate,Set,Map,console,window:{setTimeout(callback,delay){timers.push({callback,delay});return timers.length},clearTimeout(id){cancelled.push(id)}}});
 const f={states,updates,timers,cancelled,get effects(){return effects},get time(){return time},set time(value){time=value},get requests(){return requests},render(){effects=[];stateHook=0;refHook=0;return fixtureModule.exports.FamilyNetworkGraph({dossier:input,onUpdated:async()=>{}})}};
 f.render();return f;
}
test('Persisted first research batch automatically resumes once per visit',()=>{const f=visitFixture();f.effects[2]();assert.equal(f.states.get(1),true);assert.match(f.states.get(4),/progresso salvo/);f.effects[2]();assert.equal(f.updates.filter(id=>id===1).length,1)});
test('Terminal, failed, stalled, rejected and viewer maps never auto-resume',()=>{for(const mutate of [d=>d.candidates.at(-1).metadata.public_graph.continuation=false,d=>d.candidates.at(-1).metadata.public_graph.status='FAILED',d=>d.candidates.at(-1).metadata.public_graph.pagination_stalled=true,d=>d.candidates.at(-1).validation_status='REJECTED',d=>d.role='VIEWER']){const copy=structuredClone(dossier);mutate(copy);const f=visitFixture(copy);f.effects[2]();assert.equal(f.states.get(1),false);assert.equal(f.updates.filter(id=>id===1).length,0)}});
test('Pause suppresses automatic restart after dossier refresh',()=>{const f=visitFixture();f.effects[2]();const tree=f.render(),pause=findButton(tree,'Pausar expansão');assert.ok(pause);pause.props.onClick();f.render();f.effects[2]();assert.equal(f.states.get(1),false);assert.match(f.states.get(4),/pausada/)});
test('Cooldown expires with one local timer and no source polling',()=>{const copy=structuredClone(dossier),until=Date.now()+5000;copy.candidates.at(-1).metadata.public_graph.retry_not_before=new Date(until).toISOString();const f=visitFixture(copy);f.effects[2]();assert.equal(f.states.get(1),false);let tree=f.render();assert.equal(findButton(tree,'Continuar expansão').props.disabled,true);const cleanup=f.effects[3]();assert.equal(f.timers.length,1);assert.ok(f.timers[0].delay>0&&f.timers[0].delay<=5050);f.time=until+100;f.timers[0].callback();tree=f.render();assert.equal(findButton(tree,'Continuar expansão').props.disabled,false);f.effects[3]();assert.equal(f.timers.length,1);assert.equal(f.requests,0);cleanup();assert.deepEqual(f.cancelled,[1]);f.effects[2]();assert.equal(f.states.get(1),true)});
