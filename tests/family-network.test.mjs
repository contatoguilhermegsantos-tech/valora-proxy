import test from 'node:test';
import assert from 'node:assert/strict';
import {familyContext,familyNorm} from '../supabase/functions/_shared/family-discovery.ts';
import {expandFamilyNetwork} from '../supabase/functions/_shared/family-network.ts';

const context=familyContext({kind:'PERSON',name:'Pessoa Original Sobrenome',city:'Cidade QA',state:'SP',segment:'Agro'});
const full=(n=1)=>String(n).padStart(8,'0')+'000100';
const member=(name,extra={})=>({identificador_de_socio:'2',nome_socio:name,qualificacao_socio:'Sócio',cnpj_cpf_do_socio:'PRIVATE_CPF',faixa_etaria:'PRIVATE_AGE',...extra});
const row=(n=1,extra={})=>({cnpj:full(n),razao_social:n===1?'Empresa Sobrenome Rural':'Comércio Independente '+n,municipio:'Cidade QA',uf:'SP',codigo_municipio_ibge:3500001,cnae_fiscal:115600,cnae_fiscal_descricao:'Cultivo',nome_fantasia:'Marca QA',descricao_situacao_cadastral:'ATIVA',qsa:[],logradouro:'PRIVATE_ADDRESS',capital_social:123456,...extra});
const seed=(n=1,extra={})=>({candidate_id:'00000000-0000-4000-8000-'+String(n).padStart(12,'0'),full_cnpj:full(n),company_name:'Empresa Sobrenome Rural',city:'Cidade QA',state:'SP',...extra});
function source({pages=[[row(1)]],details={},basePartners,baseDetails,geo}={}){
 const calls=[];
 const fetcher=async(url,init)=>{
  const u=new URL(url);calls.push({u,init});
  if(u.hostname==='servicodados.ibge.gov.br')return Response.json(geo||[{id:3500001,nome:'Cidade QA',microrregiao:{mesorregiao:{UF:{id:35,sigla:'SP'}}}}]);
  if(u.hostname==='minhareceita.org'&&u.pathname==='/'){
   const p=u.searchParams.get('cursor')?Number(u.searchParams.get('cursor').replace('opaque-','')):0;
   const values=pages[p]||[];return Response.json({data:values,...(p<pages.length-1?{cursor:'opaque-'+(p+1)}:{})});
  }
  if(u.hostname==='minhareceita.org')return details[u.pathname.slice(1)]?Response.json(details[u.pathname.slice(1)]):new Response('',{status:404});
  if(u.pathname==='/api/v1/partners')return basePartners?basePartners(u):Response.json({data:[],links:{next:null}});
  if(u.pathname.startsWith('/api/v1/companies/'))return baseDetails?baseDetails(u.pathname.split('/').at(-1)):new Response('',{status:404});
  throw Error('Unexpected source');
 };
 return {fetcher,calls};
}
const companies=r=>r.nodes.filter(n=>n.type==='COMPANY'&&n.observation_key);
const people=r=>r.nodes.filter(n=>n.type==='PERSON_CITATION');
const jsonbText=value=>Array.isArray(value)?'['+value.map(v=>jsonbText(v===undefined?null:v)).join(', ')+']':value!==null&&typeof value==='object'?'{'+Object.entries(value).filter(([,v])=>v!==undefined).map(([k,v])=>JSON.stringify(k)+': '+jsonbText(v)).join(', ')+'}':JSON.stringify(value);

test('QSA inclui todos físicos, outros sobrenomes e nomes iguais sem mesclar identidades',async()=>{
 const io=source({pages:[[row(1,{qsa:[member('Ana Segunda Ponte'),member('Pessoa de Outra Familia'),member('Pessoa Ocultada',{nome_socio:'Nome * Sobrenome'}),member('Jurídica Sobrenome',{identificador_de_socio:1})]}),row(2,{cnae_fiscal:4712100,qsa:[member('Ana Segunda Ponte')]})]]});
 const r=await expandFamilyNetwork(context,[seed()],{},io);
 assert.equal(r.status,'PARTIAL');assert.equal(r.complete,false);assert.equal(companies(r).length,2);assert.equal(people(r).length,3);
 assert.equal(people(r).filter(n=>n.person_name==='Ana Segunda Ponte').length,2);assert.ok(people(r).some(n=>n.person_name==='Pessoa de Outra Familia'));
 assert.equal(r.edges.filter(e=>e.kind==='SAME_NAME_CANDIDATE').length,1);assert.equal(r.edges.filter(e=>e.kind==='QSA_PARTICIPATION').length,3);
 assert.ok(r.nodes.every(n=>n.identity_confirmed===false&&n.kinship_confirmed===false));assert.ok(r.edges.every(e=>e.confidence==='LOW'&&e.validation_status==='UNVALIDATED'&&e.identity_confirmed===false));
 assert.doesNotMatch(JSON.stringify(r),/PRIVATE_|cnpj_cpf|faixa_etaria|logradouro|capital_social/);
 assert.ok(!people(r).some(n=>'city'in n||'state'in n));assert.ok(r.observations.every(o=>o.source_url==='https://minhareceita.org/'+o.full_cnpj));
});
test('empresa de outro setor e razão social com nome físico completo entram como pistas',async()=>{
 const io=source({pages:[[row(1,{qsa:[member('Ana Segunda Ponte')]}),row(2,{razao_social:'ANA SEGUNDA PONTE E CIA LTDA',cnae_fiscal:4712100,cnae_fiscal_descricao:'Comércio varejista'})]]});
 const r=await expandFamilyNetwork(context,[seed()],{},io);assert.equal(companies(r).length,2);assert.equal(companies(r).find(n=>n.full_cnpj===full(2)).cnae_code,'4712100');assert.ok(r.edges.some(e=>e.match_basis==='LEGAL_NAME_EXACT_PERSON_NAME'));assert.equal(r.search_lineage.sector_filter_applied,false);
});
test('novo token de QSA ancorado amplia o município sem concluir parentesco',async()=>{
 const io=source({pages:[[row(1,{qsa:[member('Ana Segunda Ponte')]}),row(2,{razao_social:'Comércio Ponte LTDA',cnae_fiscal:4712100,qsa:[member('Carlos Nova Travessia')]}),row(3,{razao_social:'Travessia Serviços',cnae_fiscal:6201501})]]});
 const r=await expandFamilyNetwork(context,[seed()],{},io);assert.equal(companies(r).length,3);assert.ok(r.edges.some(e=>e.kind==='SURNAME_CONTEXT_CANDIDATE'&&e.match_basis==='QSA_NAME_TOKEN'));assert.equal(companies(r).find(n=>n.full_cnpj===full(3)).depth,3);assert.ok(r.nodes.every(n=>n.depth<=3));
});
test('índice de páginas anteriores é reavaliado depois que o QSA revela nome novo',async()=>{
 let now=1000,fail=true;const base=source({pages:[[row(2,{qsa:[member('Ana Segunda Ponte')],cnae_fiscal:4712100})],[row(1,{qsa:[member('Ana Segunda Ponte')]})]]});
 const fetcher=async(url,init)=>{const u=new URL(url);if(u.hostname==='minhareceita.org'&&u.pathname==='/'&&u.searchParams.has('cursor')&&fail)throw new DOMException('private','TimeoutError');return base.fetcher(url,init)};
 const first=await expandFamilyNetwork(context,[seed()],{},{fetcher,clock:()=>now});assert.equal(first.state.municipal_index.length,1);assert.equal(companies(first).length,0);assert.ok(first.state.retry_not_before);
 now+=31000;fail=false;const second=await expandFamilyNetwork(context,[seed()],first.state,{fetcher,clock:()=>now});assert.equal(second.state.scanned_count,2);assert.ok(companies(second).some(n=>n.full_cnpj===full(2)));assert.equal(second.state.municipal_exhausted,true);
});
test('oito páginas por rodada retomam cursor opaco, sem novo processamento da cidade',async()=>{
 const pages=Array.from({length:10},(_,p)=>[row(p+1)]),io=source({pages});const first=await expandFamilyNetwork(context,[],{},io);assert.equal(first.state.pages_scanned,8);assert.equal(first.state.municipal_cursor,'opaque-8');assert.equal(first.continuation,true);const second=await expandFamilyNetwork(context,[],first.state,io);assert.equal(second.state.pages_scanned,10);assert.equal(second.state.scanned_count,10);assert.equal(second.state.municipal_exhausted,true);assert.equal(second.continuation,false);assert.equal(io.calls.filter(c=>c.u.hostname.includes('ibge')).length,1);
});
test('tokens fracos aguardam todas páginas; correspondência exata tardia recebe prioridade',async()=>{
 const qsa=member('Ana Nome Frequente'),pages=[[row(1,{qsa:[qsa]})],...Array.from({length:8},(_,p)=>Array.from({length:100},(_,i)=>row(100+p*100+i,{razao_social:'Frequente Comércio '+i}))),[row(2,{cnae_fiscal:4712100,qsa:[qsa]})]];
 const io=source({pages}),first=await expandFamilyNetwork(context,[seed()],{},io);assert.equal(first.state.pages_scanned,8);assert.equal(companies(first).length,1);assert.equal(first.state.limits_reached.length,0);const second=await expandFamilyNetwork(context,[seed()],first.state,io);assert.ok(companies(second).some(n=>n.full_cnpj===full(2)));assert.ok(companies(second).length<=32);assert.ok(second.state.coverage_errors.includes('WEAK_NAME_TOKEN_EXPANSION_LIMIT_30'));
});
test('CNPJ é único e descartes de empresa/citação são preservados entre rodadas',async()=>{
 const io=source({pages:[[row(1,{qsa:[member('Ana Segunda Ponte'),member('Pessoa de Outra Familia')]}),row(2,{qsa:[member('Ana Segunda Ponte')]})]]}),first=await expandFamilyNetwork(context,[seed(),seed(1)],{},io);
 const rejected=people(first).find(n=>n.person_name==='Pessoa de Outra Familia').key;const next=await expandFamilyNetwork(context,[seed(),seed(2)],first.state,{...io,excludedCnpjs:[full(2)],excludedNodeKeys:[rejected]});assert.equal(next.nodes.filter(n=>n.type==='COMPANY').length,1);assert.ok(!next.nodes.some(n=>n.key===rejected||n.full_cnpj===full(2)));assert.ok(next.edges.every(e=>next.nodes.some(n=>n.key===e.from)&&next.nodes.some(n=>n.key===e.to)));assert.ok(!next.state.detail_queue.some(t=>t.full_cnpj===full(2)));assert.ok(next.observations.every(o=>o.full_cnpj!==full(2)));
});
test('cursor estacionado/cíclico é terminal parcial; ausência/null é término experimental',async()=>{
 for(const value of [undefined,null]){const io=source();const f=async(url,init)=>new URL(url).hostname==='minhareceita.org'?Response.json({data:[],...(value!==undefined?{cursor:value}:{})}):io.fetcher(url,init);const r=await expandFamilyNetwork(context,[],{},{fetcher:f});assert.equal(r.state.municipal_exhausted,true);assert.equal(r.complete,false);assert.equal(r.continuation,false)}
 const io=source();let page=0;const f=async(url,init)=>new URL(url).hostname==='minhareceita.org'?Response.json({data:[],cursor:++page===1?'same':'same'}):io.fetcher(url,init);const r=await expandFamilyNetwork(context,[],{},{fetcher:f});assert.equal(r.state.pagination_stalled,true);assert.equal(r.continuation,false);let extra=0;const next=await expandFamilyNetwork(context,[],r.state,{fetcher:async()=>{extra++;throw Error()}});assert.equal(extra,0);assert.equal(next.continuation,false);
});
test('429 preserva cursor e cooldown sem consultar cedo nem seguir redirect',async()=>{
 let now=1000;const io=source();const f=async(url,init)=>new URL(url).hostname==='minhareceita.org'?new Response('',{status:429,headers:{'Retry-After':'90'}}):io.fetcher(url,init);const first=await expandFamilyNetwork(context,[],{},{fetcher:f,clock:()=>now});assert.equal(first.status,'FAILED');assert.equal(first.state.municipal_cursor,null);assert.equal(Date.parse(first.state.retry_not_before),91000);let calls=0;const second=await expandFamilyNetwork(context,[],first.state,{fetcher:async()=>{calls++;throw Error()},clock:()=>now+1000});assert.equal(calls,0);assert.equal(second.state.retry_not_before,first.state.retry_not_before);assert.ok(io.calls.every(c=>c.init.redirect==='error'&&!('Authorization'in c.init.headers)));
});
test('formato/cidade/UF incorretos e CNPJ de outro registro não geram evidência ou aresta',async()=>{
 const io=source({pages:[[{...row(1),codigo_municipio_ibge:3100001,uf:'MG'},{...row(2),cnpj:'invalid'}]],details:{[full(1)]:row(99)}}),r=await expandFamilyNetwork(context,[seed()],{},io);assert.equal(r.observations.length,0);assert.equal(r.edges.length,0);assert.ok(r.state.coverage_errors.includes('MUNICIPAL_INVALID_COMPANY_ROW'));assert.ok(r.state.coverage_errors.includes('DETAIL_CNPJ_OR_FORMAT_MISMATCH'));assert.equal(r.complete,false);
});
test('ambiguidade IBGE bloqueia antes de empresas; fontes desabilitadas não fazem HTTP',async()=>{
 const io=source({geo:[{id:3500001,nome:'Cidade QA',microrregiao:{mesorregiao:{UF:{sigla:'SP'}}}},{id:3500002,nome:'Cidade QA',microrregiao:{mesorregiao:{UF:{sigla:'SP'}}}}]}),r=await expandFamilyNetwork(context,[],{},io);assert.equal(r.status,'BLOCKED');assert.equal(io.calls.length,1);let calls=0;const disabled=await expandFamilyNetwork(context,[seed()],{},{minhaAvailable:false,baseAvailable:false,fetcher:async()=>{calls++;throw Error()}});assert.equal(disabled.status,'BLOCKED');assert.equal(calls,0);
});
test('nome completo inverso documentado alcança estabelecimentos de outra cidade/setor',async()=>{
 const name='Ana Segunda Ponte';const io=source({pages:[[row(1,{qsa:[member(name)]})]],basePartners:u=>Response.json({data:u.searchParams.get('filter[partner_name]')===name?[{basic_cnpj:'00000009',partner_name:name,partner_identifier:{code:'2'},is_legal_entity:false,name_redacted:false}]:[],links:{next:null}}),baseDetails:root=>Response.json({data:{basic_cnpj:root,corporate_name:'Empresa em Outra Cidade',partners:[{partner_name:name,partner_identifier:{code:2},is_legal_entity:false,role:'Administrador'}],establishments:[{full_cnpj:full(9),main_cnae:'6201501',address:{city:{name:'Outra Cidade'},state:{abbreviation:'MG'},street:'PRIVATE_ADDRESS'}}]}})});
 const r=await expandFamilyNetwork(context,[seed()],{},{...io,baseAvailable:true});assert.ok(companies(r).some(n=>n.full_cnpj===full(9)&&n.city==='Outra Cidade'&&n.cnae_code==='6201501'));assert.ok(r.observations.some(o=>o.provider==='BASE_EMPRESARIAL'));assert.ok(r.edges.some(e=>e.kind==='SAME_NAME_CANDIDATE'));assert.ok(io.calls.filter(c=>c.u.pathname.endsWith('/partners')).every(c=>c.u.searchParams.get('filter[partner_identifier]')==='2'&&!c.u.searchParams.has('city_id')));assert.doesNotMatch(JSON.stringify(r),/PRIVATE_/);
});
test('busca inversa sem links.next ou com homônimo diferente é inconclusiva',async()=>{
 for(const body of [{data:[]},{data:[{basic_cnpj:'00000009',partner_name:'Pessoa Não Pesquisada',partner_identifier:{code:2},is_legal_entity:false}],links:{next:null}}]){const io=source({basePartners:()=>Response.json(body)}),r=await expandFamilyNetwork(context,[seed()],{},{...io,baseAvailable:true});assert.ok(!companies(r).some(n=>n.full_cnpj===full(9)));assert.ok(r.state.coverage_errors.some(e=>e.startsWith('INVERSE_INVALID')));assert.equal(r.complete,false)}
});
test('falha inversa tem cooldown, até duas tentativas e depois termina parcial',async()=>{
 let now=1000;const io=source({basePartners:()=>{throw new DOMException('private network','TimeoutError')}});const first=await expandFamilyNetwork(context,[seed()],{},{...io,clock:()=>now,baseAvailable:true});assert.ok(Date.parse(first.state.retry_not_before)>now);let calls=0;const early=await expandFamilyNetwork(context,[seed()],first.state,{...io,fetcher:async()=>{calls++;throw Error()},clock:()=>now+1000,baseAvailable:true});assert.equal(calls,0);now+=31000;const second=await expandFamilyNetwork(context,[seed()],early.state,{...io,clock:()=>now,baseAvailable:true});assert.equal(second.continuation,false);assert.ok(second.state.inverse_queries.every(q=>q.done));assert.ok(second.state.coverage_errors.includes('INVERSE_SOURCE_UNAVAILABLE_AFTER_2_ATTEMPTS'));assert.doesNotMatch(JSON.stringify(second.search_lineage.source_attempts),/private/);
});
test('HTTP200 inverso com formato inválido conserva tentativa e termina na segunda resposta',async()=>{
 const io=source({basePartners:()=>Response.json({data:[]})});const first=await expandFamilyNetwork(context,[seed()],{},{...io,baseAvailable:true});assert.equal(first.state.inverse_queries[0].attempts,1);assert.equal(first.state.inverse_queries[0].done,false);assert.equal(first.continuation,true);
 const second=await expandFamilyNetwork(context,[seed()],first.state,{...io,baseAvailable:true});assert.equal(second.state.inverse_queries[0].attempts,2);assert.equal(second.state.inverse_queries[0].done,true);assert.equal(second.continuation,false);assert.ok(second.state.coverage_errors.includes('INVERSE_SOURCE_UNAVAILABLE_AFTER_2_ATTEMPTS'));
 let calls=0;const third=await expandFamilyNetwork(context,[seed()],second.state,{baseAvailable:true,fetcher:async()=>{calls++;throw Error()}});assert.equal(calls,0);assert.equal(third.continuation,false);
});
test('cooldown Base não interrompe cursor saudável Minha, mas pausa inverso ao acabar município',async()=>{
 const pages=Array.from({length:9},()=>[]);pages[8]=[row(1)];let now=1000;
 const io=source({pages,baseDetails:()=>{throw new DOMException('private network','TimeoutError')}});
 const first=await expandFamilyNetwork(context,[seed()],{},{...io,baseAvailable:true,clock:()=>now});assert.equal(first.state.municipal_exhausted,false);assert.equal(first.continuation,true);assert.ok(first.state.cooldowns.BASE_EMPRESARIAL);assert.equal(first.state.retry_not_before,null);
 const second=await expandFamilyNetwork(context,[seed()],first.state,{...io,baseAvailable:true,clock:()=>now});assert.equal(second.state.municipal_exhausted,true);assert.equal(second.state.retry_not_before,first.state.cooldowns.BASE_EMPRESARIAL);assert.equal(second.continuation,true);assert.ok(companies(second).some(n=>n.full_cnpj===full(1)));
});
test('429 no detalhe Base preserva fila e não consome tentativa',async()=>{
 const io=source({pages:[[]],baseDetails:()=>new Response('',{status:429,headers:{'Retry-After':'90'}})});const r=await expandFamilyNetwork(context,[seed()],{},{...io,baseAvailable:true});assert.equal(r.state.detail_queue[0].attempts,0);assert.ok(r.state.cooldowns.BASE_EMPRESARIAL);assert.equal(r.complete,false);
});
test('limites de nós/QSA e prazo são explícitos sem COMPLETED ou relações fabricadas',async()=>{
 const capped=await expandFamilyNetwork(context,Array.from({length:121},(_,i)=>seed(i+1)),{},{fetcher:async()=>{throw Error('No HTTP expected')}});assert.equal(capped.nodes.filter(n=>n.type==='COMPANY').length,120);assert.ok(capped.state.limits_reached.includes('GRAPH_COMPANY_LIMIT_120'));assert.equal(capped.continuation,false);assert.equal(capped.edges.length,0);
 const io=source({pages:[[row(1,{qsa:Array.from({length:101},(_,i)=>member('Nome '+i+' Familia'))})]]}),qsa=await expandFamilyNetwork(context,[seed()],{},io);assert.equal(people(qsa).length,100);assert.ok(qsa.state.coverage_errors.includes('QSA_PARTIAL_OR_MISSING'));
 let clock=0;const timed=await expandFamilyNetwork(context,[],{},{fetcher:async(url,init)=>{clock+=6000;return source().fetcher(url,init)},clock:()=>clock,deadlineMs:10000});assert.ok(clock<=12000);assert.equal(timed.complete,false);
});
test('checkpoint e respostas limitam bytes UTF8; payload bruto acima2MB é recusado',async()=>{
 const huge=source(),r=await expandFamilyNetwork(context,[],{},{fetcher:async(url,init)=>new URL(url).hostname==='minhareceita.org'?new Response('x'.repeat(2*1024*1024+1)):huge.fetcher(url,init)});assert.equal(r.status,'FAILED');assert.ok(r.search_lineage.source_attempts.some(a=>a.error==='RESPONSE_TOO_LARGE'));
 const names=Array.from({length:10},(_,i)=>member('Á'.repeat(90)+' '+'Ó'.repeat(90)+' '+i));const pages=Array.from({length:8},(_,p)=>Array.from({length:100},(_,i)=>row(100+p*100+i,{qsa:names})));const io=source({pages}),bounded=await expandFamilyNetwork(context,[],{},io);assert.ok(new TextEncoder().encode(jsonbText(bounded.state)).byteLength<=2000000);assert.ok(bounded.state.limits_reached.some(e=>e.includes('PAYLOAD_LIMIT_2MB')));assert.equal(bounded.continuation,false);assert.equal(bounded.search_lineage.limits.indexBytes,2000000);
});
test('checkpoint abaixo do teto JSONB conserva todos2399 registros sem poda',async()=>{
 const pages=Array.from({length:24},(_,p)=>Array.from({length:p===23?99:100},(_,i)=>row(100+p*100+i)));const io=source({pages});let previous={};let r;for(let n=0;n<3;n++){r=await expandFamilyNetwork(context,[],previous,io);previous=r.state}assert.equal(r.state.municipal_exhausted,true);assert.equal(r.state.municipal_index.length,2399);assert.equal(r.state.limits_reached.length,0);const bytes=new TextEncoder().encode(jsonbText(r.state)).byteLength;assert.ok(bytes>new TextEncoder().encode(JSON.stringify(r.state)).byteLength);assert.ok(bytes<2000000);assert.equal(r.continuation,false);
});
test('mudança de contexto reinicia checkpoint; fonte documental versiona sem reutilizar conteúdo diferente',async()=>{
 const io=source({pages:[[row(1,{qsa:[member('Ana Segunda Ponte')]})]]}),first=await expandFamilyNetwork(context,[seed()],{},io);const changed=familyContext({...context,kind:'PERSON',name:'Pessoa Original Diferente',city:'Cidade QA',state:'SP',segment:'Agro'});const fresh=await expandFamilyNetwork(changed,[],first.state,source({pages:[[]]}));assert.notEqual(fresh.state.query_fingerprint,first.state.query_fingerprint);assert.equal(fresh.state.municipal_index.length,0);assert.equal(fresh.edges.length,0);
 const updated=await expandFamilyNetwork(context,[seed()],{},source({pages:[[row(1,{qsa:[member('Ana Segunda Ponte')],descricao_situacao_cadastral:'BAIXADA'})]]}));assert.notEqual(updated.observations[0].key,first.observations[0].key);assert.ok(first.observations[0].registration_status==='ATIVA');
});
test('CPF embutido em texto empresarial é removido na fonte/reuse; CNPJ14 permanece',async()=>{
 const hidden='12345678901',formatted='123.456.789-01';const io=source({pages:[[row(1,{razao_social:'Empresa Sobrenome '+hidden+' CNPJ '+full(1),nome_fantasia:'Marca '+formatted,qsa:[member('Nome Malformado '+hidden),member('Ana Segunda Ponte')]})]]});
 const first=await expandFamilyNetwork(context,[seed()],{},io);const serialized=JSON.stringify(first);assert.ok(!serialized.includes(hidden)&&!serialized.includes(formatted));assert.ok(companies(first)[0].label.includes(full(1)));assert.ok(companies(first)[0].label.includes('[identificador removido]'));assert.equal(people(first).length,1);
 const legacy=structuredClone(first.state);legacy.municipal_index[0].company_name='Empresa Sobrenome '+hidden;legacy.observations[0].trade_name='Marca '+formatted;legacy.nodes.find(n=>n.type==='COMPANY').label='Empresa Sobrenome '+hidden;
 const resumed=await expandFamilyNetwork(context,[seed()],legacy,{fetcher:async()=>{throw Error('No external query expected')}});assert.ok(!JSON.stringify(resumed).includes(hidden)&&!JSON.stringify(resumed).includes(formatted));assert.equal(resumed.nodes.find(n=>n.type==='COMPANY').full_cnpj,full(1));
});
