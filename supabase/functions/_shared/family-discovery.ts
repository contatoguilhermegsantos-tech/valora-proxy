import {fetchSourceJson} from './source-operations.ts';
import {discoverMinhaFamily} from './minha-family-discovery.ts';
const API='https://app.baseempresarial.com.br/api/v1';
const IBGE='https://servicodados.ibge.gov.br/api/v1/localidades';
export const familyNorm=(v:unknown)=>String(v??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().replace(/[^A-Z0-9 ]/g,' ').replace(/\s+/g,' ').trim();
const cnpj=(v:unknown)=>String(v??'').toUpperCase().replace(/[^A-Z0-9]/g,'');
const cnae=(v:unknown)=>{const s=String(v??'').replace(/\D/g,'');return s&&s.length<=7?s.padStart(7,'0'):''};
const text=(v:unknown,n=255)=>String(v??'').trim().slice(0,n);
export const surnameToken=(name:unknown)=>{const tokens=familyNorm(name).split(' ').filter(v=>v&&!['DA','DAS','DE','DO','DOS','E','JUNIOR','FILHO','NETO','SOBRINHO'].includes(v));return tokens.length>=2&&tokens.at(-1)!.length>=3?tokens.at(-1)!:null};
export function familySegmentRule(segment:unknown,strategy?:unknown){
 const raw=text(segment),normalized=familyNorm(raw),exact=raw.match(/(?:^|\b)(\d{2}[.\-/]?\d{2}[.\-/]?\d[.\-/]?\d{2})(?:\b|$)/)?.[1]?.replace(/\D/g,'');
 if(exact?.length===7)return {kind:'CNAE_EXACT',codes:[exact],prefixes:[] as string[],basis:'EXPLICIT_CNAE'};
 // The recorded segment is the context: a strategy cannot silently replace it.
 if(/\b(AGRO|AGRONEGOCIO|AGROPECUARIA|AGRICOLA|AGRICULTURA|PECUARIA|RURAL|FAZENDA|CULTIVO)\b/.test(normalized))return {kind:'AGRO_PREFIX',codes:[] as string[],prefixes:['01','02','03'],basis:'EXPLICIT_AGRO_SEGMENT'};
 if(/\b(MEDICO|MEDICA|MEDICINA|SAUDE|HOSPITAL|HOSPITALAR)\b/.test(normalized))return {kind:'HEALTH_PREFIX',codes:[] as string[],prefixes:['86'],basis:'EXPLICIT_HEALTH_SEGMENT'};
 return null;
}
export function familyContext(lead:any,strategy?:unknown){
 const surname=surnameToken(lead.name),city=text(lead.city,120),state=text(lead.state,2).toUpperCase(),segment=text(lead.segment),segment_rule=familySegmentRule(segment,strategy);
 if(lead.kind!=='PERSON'||!surname||!city||!/^[A-Z]{2}$/.test(state)||!segment||!segment_rule)return {ok:false as const,reason:'Pessoa, sobrenome útil, município, UF e segmento/CNAE utilizável são necessários.'};
 return {ok:true as const,surname,city,state,segment,segment_rule,lead_name:text(lead.name)};
}
export type FamilyContext=Extract<ReturnType<typeof familyContext>,{ok:true}>;
type Context=FamilyContext;
export type FamilyCompany={full_cnpj:string;basic_cnpj:string;company_name:string;city:string;state:string;cnae_code:string;cnae_description:string;attempts?:number};
export type FamilyMatch=FamilyCompany&{entity_type:'PERSON'|'COMPANY';person_name?:string;match_basis:'QSA_PERSON'|'COMPANY_NAME';partner_role?:string;source_provider?:'BASE_EMPRESARIAL'|'MINHA_RECEITA'};
type Match=FamilyMatch;
type GeographyProvider='IBGE_LOCALIDADES'|'BASE_EMPRESARIAL';
export type FamilySourceResult={ok:boolean;status:number|null;data:any;error:string|null;retry_after_seconds?:number};
export type FamilyBaseFallback=(path:string,validator:(d:any)=>boolean,options:{timeoutMs:number})=>Promise<FamilySourceResult>;
type SourceAttempt={provider:GeographyProvider|'MINHA_RECEITA';transport:'DIRECT'|'AUTHENTICATED_BRIDGE';endpoint:string;status:number|null;error:string|null;duration_ms:number};
export type FamilyState={query_fingerprint:string;scanned_cnpjs:string[];scanned_count:number;next_page:number|null;backlog:FamilyCompany[];listing_exhausted:boolean;qsa_incomplete_roots:string[];candidate_limit_reached:boolean;coverage_incomplete:boolean;retry_not_before:string|null;city_code:string|null;pages_scanned:number;last_error?:string|null;source_provider?:'BASE_EMPRESARIAL'|'MINHA_RECEITA';source_cursor?:string|null;source_cursor_stalled?:boolean;source_data_month?:string|null;geography_provider?:GeographyProvider;geography_preprocessor?:{provider:GeographyProvider;source_url:string;municipality_code:string;municipality_name:string;state:string;validation:'EXACT_CITY_UF';queried_at:string|null};source_attempts?:SourceAttempt[]};
const hasSurname=(name:unknown,surname:string)=>familyNorm(name).split(' ').includes(surname);
const activity=(code:string,rule:Context['segment_rule'])=>rule.codes.includes(code)||rule.prefixes.some(p=>code.startsWith(p));
function safeCompany(raw:any,context:Context,cityCode?:string):FamilyCompany|null{
 const full=cnpj(raw.full_cnpj),code=cnae(raw.main_cnae??raw.cnae_code),city=text(raw.city_name??raw.city,120),state=text(raw.state_abbreviation??raw.state,2).toUpperCase();
 if(!/^[A-Z0-9]{12}\d{2}$/.test(full)||!code||!activity(code,context.segment_rule)||familyNorm(city)!==familyNorm(context.city)||state!==context.state||cityCode&&raw.city_id!=null&&String(raw.city_id)!==cityCode)return null;
 return {full_cnpj:full,basic_cnpj:full.slice(0,8),company_name:text(raw.corporate_name??raw.company_name),city,state,cnae_code:code,cnae_description:text(raw.main_cnae_name??raw.cnae_description),attempts:Number(raw.attempts)||0};
}
export async function familyStableId(scope:string){
 const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(scope)));bytes[6]=(bytes[6]&15)|80;bytes[8]=(bytes[8]&63)|128;
 const h=[...bytes.subarray(0,16)].map(b=>b.toString(16).padStart(2,'0')).join('');return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
export const familyQueryFingerprint=(context:Context)=>familyStableId(JSON.stringify(['family-context-v1',familyNorm(context.lead_name),context.surname,familyNorm(context.city),context.state,context.segment_rule]));
export async function familyResumeState(context:Context,previous:any={}):Promise<FamilyState>{
 const fingerprint=await familyQueryFingerprint(context);
 const same=previous?.query_fingerprint===fingerprint;
 const state:FamilyState={query_fingerprint:fingerprint,scanned_cnpjs:same&&Array.isArray(previous.scanned_cnpjs)?[...new Set<string>(previous.scanned_cnpjs.map(cnpj).filter((v:string)=>/^[A-Z0-9]{12}\d{2}$/.test(v)))].slice(-500):[],scanned_count:same?Math.max(Number(previous.scanned_count)||0,Array.isArray(previous.scanned_cnpjs)?previous.scanned_cnpjs.length:0):0,next_page:same&&(previous.next_page===null||Number.isInteger(previous.next_page)&&previous.next_page>0)?previous.next_page:1,backlog:[],listing_exhausted:same&&previous.listing_exhausted===true,qsa_incomplete_roots:same&&Array.isArray(previous.qsa_incomplete_roots)?previous.qsa_incomplete_roots.map(cnpj).filter((s:string)=>s.length===8).slice(0,500):[],city_code:same&&/^\d{7}$/.test(String(previous.city_code))?String(previous.city_code):null,pages_scanned:same?Number(previous.pages_scanned)||0:0,candidate_limit_reached:same&&previous.candidate_limit_reached===true,coverage_incomplete:same&&previous.coverage_incomplete===true,retry_not_before:same&&Number.isFinite(Date.parse(previous.retry_not_before))?previous.retry_not_before:null,last_error:null};
 if(same&&Array.isArray(previous.backlog))state.backlog=previous.backlog.map((r:any)=>safeCompany(r,context,state.city_code||undefined)).filter(Boolean).slice(0,500) as FamilyCompany[];
 if(same&&state.city_code&&['IBGE_LOCALIDADES','BASE_EMPRESARIAL'].includes(previous.geography_provider)){state.geography_provider=previous.geography_provider;state.geography_preprocessor={provider:state.geography_provider!,source_url:state.geography_provider==='IBGE_LOCALIDADES'?`${IBGE}/estados/${context.state}/municipios`:`${API}/locations/cities`,municipality_code:state.city_code,municipality_name:context.city,state:context.state,validation:'EXACT_CITY_UF',queried_at:Number.isFinite(Date.parse(previous.geography_preprocessor?.queried_at))?previous.geography_preprocessor.queried_at:null}}
 state.source_attempts=[];
 state.source_provider=same&&previous.source_provider==='MINHA_RECEITA'?'MINHA_RECEITA':'BASE_EMPRESARIAL';
 state.source_cursor=same&&typeof previous.source_cursor==='string'&&previous.source_cursor.length>0&&previous.source_cursor.length<=1024?previous.source_cursor:null;
 state.source_cursor_stalled=same&&previous.source_cursor_stalled===true;
 state.source_data_month=same&&/^\d{4}-\d{2}$/.test(String(previous.source_data_month))?previous.source_data_month:null;
 return state;
}
type Options={fetcher?:typeof fetch;baseFallback?:FamilyBaseFallback;now?:()=>number;deadlineMs?:number;baseAvailable?:boolean;minhaAvailable?:boolean;geographyOnly?:boolean};
const transient=(error:unknown)=>['TIMEOUT','NETWORK_ERROR'].includes(String(error));
const forbiddenFailure=(attempt:any)=>attempt?.provider==='BASE_EMPRESARIAL'&&([401,403,429].includes(attempt.status)||['INVALID_RESPONSE','RESPONSE_TOO_LARGE'].includes(attempt.error));
export async function discoverFamilyContext(context:Context,previous:any={},options:Options={}){
 const clock=options.now||Date.now,deadline=clock()+(options.deadlineMs||45000),baseAvailable=options.baseAvailable!==false,minhaAvailable=options.minhaAvailable===true;
 const state=await familyResumeState(context,previous),same=state.query_fingerprint===previous?.query_fingerprint;
 if(!baseAvailable&&!minhaAvailable)return {status:'BLOCKED',complete:false,candidates:[],state,search_lineage:{business_provider:null},notes:['SOURCE_NOT_AVAILABLE'],qsa_reads:0,continuation:false,source_provider:null,source_key:null};
 const previousFailed=same&&Array.isArray(previous.source_attempts)&&previous.source_attempts.some((a:any)=>a.provider==='BASE_EMPRESARIAL'&&transient(a.error))&&!previous.source_attempts.some(forbiddenFailure)&&previous.complete!==true;
 async function minha(progress:FamilyState,baseCandidates:Match[]=[],switched=false){
  let resolved=progress;
  if(!resolved.city_code){const geo=await discoverBaseFamilyContext(context,{}, {...options,geographyOnly:true,deadlineMs:Math.min(15000,Math.max(1200,deadline-clock()-1200))});if(!geo.state.city_code)return geo;resolved=geo.state}
  const result=await discoverMinhaFamily(context,resolved,{fetcher:options.fetcher,now:clock,deadline});
  const all=[...baseCandidates.map(c=>({...c,source_provider:'BASE_EMPRESARIAL' as const})),...result.candidates];
  const unique=[...new Map(all.map(c=>[c.entity_type+'|'+familyNorm(c.person_name||c.company_name)+'|'+c.full_cnpj,c])).values()];
  if(unique.length>60){result.state.candidate_limit_reached=true;result.notes.push('COMBINED_CANDIDATE_COVERAGE_LIMIT_60')}
  result.candidates.splice(0,result.candidates.length,...unique.slice(0,60));
  if(baseCandidates.length&&result.status==='FAILED')result.status='PARTIAL';
  return {...result,source_key:'minha_receita_rfb',search_lineage:{...result.search_lineage,business_provider:'MINHA_RECEITA',provider_switch:switched,previous_provider:switched?'BASE_EMPRESARIAL':null,previous_provider_transport_failed:switched&&(baseCandidates.length>0||previousFailed)}};
 }
 if(minhaAvailable&&(!baseAvailable||state.source_provider==='MINHA_RECEITA'||previousFailed))return minha(state,[],state.source_provider!=='MINHA_RECEITA');
 const base=await discoverBaseFamilyContext(context,state.source_provider==='MINHA_RECEITA'?{}:previous,{...options,deadlineMs:minhaAvailable?Math.min(30000,Math.max(1200,deadline-clock()-15000)):Math.max(1200,deadline-clock())});
 if(minhaAvailable&&base.fallback_eligible&&deadline-clock()>1200){const result=await minha(base.state,base.candidates,true);return {...result,search_lineage:{...result.search_lineage,previous_provider_transport_failed:true}}}
 return {...base,source_key:'base_empresarial_rfb'};
}
async function discoverBaseFamilyContext(context:Context,previous:any={},options:Options={}){
 const clock=options.now||Date.now,started=clock(),deadline=started+(options.deadlineMs||45000),fetcher=options.fetcher||fetch,state=await familyResumeState(context,previous);
 state.source_provider='BASE_EMPRESARIAL';
 const matches:Match[]=[],notes:string[]=[];let failed=false,reviewIncomplete=false,qsaReads=0,rateLimited=false,preferBridge=false,transportFailed=false,fallbackBlocked=false;let directFailure:FamilySourceResult|null=null;
 async function read(path:string,valid:(d:any)=>boolean){
  const official=path.startsWith(IBGE+'/'),bridgeEligible=!official&&path.startsWith('/companies/'),provider:GeographyProvider=official?'IBGE_LOCALIDADES':'BASE_EMPRESARIAL';
  const endpoint=official?'IBGE /estados/{UF}/municipios':path.startsWith('/companies/search')?'BASE /companies/search':path.startsWith('/companies/')?'BASE /companies/{basic_cnpj}':path.includes('/cities/stats')?'BASE /locations/states/{ibge}/cities/stats':path.startsWith('/locations/cities')?'BASE /locations/cities':'BASE /locations/states';
  const remaining=deadline-clock();if(remaining<1200){notes.push('DEADLINE');return {ok:false,data:null,status:null,error:'DEADLINE'}}
  if(rateLimited)return {ok:false,data:null,status:429,error:'HTTP_429'};
  async function bridge(){
   const bridgeStarted=clock();let result:FamilySourceResult;
   try{result=await options.baseFallback!(path,valid,{timeoutMs:Math.min(8000,Math.max(300,deadline-clock()-600))});if(result.ok&&!valid(result.data))result={ok:false,status:result.status,data:null,error:'INVALID_RESPONSE'}}catch{result={ok:false,status:null,data:null,error:'NETWORK_ERROR'}}
   state.source_attempts!.push({provider,transport:'AUTHENTICATED_BRIDGE',endpoint,status:result.status,error:result.error,duration_ms:Math.max(0,clock()-bridgeStarted)});
   if([401,403,429].includes(Number(result.status))||['INVALID_RESPONSE','RESPONSE_TOO_LARGE'].includes(result.error||''))fallbackBlocked=true;
   if(result.status===429){rateLimited=true;state.retry_not_before=new Date(clock()+Math.max(1,Number(result.retry_after_seconds)||60)*1000).toISOString();notes.push('RATE_LIMIT_RETRY_AFTER')}
   return result;
  }
  if(bridgeEligible&&preferBridge&&options.baseFallback){const bridged=await bridge();if(bridged.ok)return bridged;transportFailed=true;notes.push('BASE_AUTHENTICATED_BRIDGE_FAILED');return bridged.status===429?bridged:directFailure!}
  const queryStarted=clock(),result=await fetchSourceJson(official?path:API+path,valid,{fetcher:async(url,init)=>{const response=await fetcher(url,init);if(!official&&response.status===429){const header=response.headers.get('Retry-After')||'60',seconds=/^\d+$/.test(header)?Number(header):Math.max(0,(Date.parse(header)-clock())/1000)||60;if(seconds>2){rateLimited=true;state.retry_not_before=new Date(clock()+seconds*1000).toISOString()}}return response},timeoutMs:Math.min(official?4000:6000,Math.max(300,Math.floor((remaining-600)/2))),headers:{'User-Agent':'MAX-Intelligence/1.0'}});
  state.source_attempts!.push({provider,transport:'DIRECT',endpoint,status:result.status,error:result.error,duration_ms:Math.max(0,clock()-queryStarted)});
  if(bridgeEligible&&!result.ok&&['TIMEOUT','NETWORK_ERROR'].includes(result.error||'')&&options.baseFallback&&deadline-clock()>1200){const bridged=await bridge();if(bridged.ok){preferBridge=true;directFailure=result;notes.push('BASE_AUTHENTICATED_BRIDGE_USED');return bridged}notes.push('BASE_AUTHENTICATED_BRIDGE_FAILED');if(bridged.status===429)return bridged}
  if(!official&&!result.ok){if(transient(result.error))transportFailed=true;if([401,403,429].includes(Number(result.status))||['INVALID_RESPONSE','RESPONSE_TOO_LARGE'].includes(result.error||''))fallbackBlocked=true}
  if(result.status===429)notes.push('RATE_LIMIT_RETRY_AFTER');return result;
 }
 function lineage(){return {original:{name:context.lead_name,city:context.city,state:context.state,segment:context.segment},query_surname:context.surname,geographic_filter_applied:Boolean(state.city_code),city_code:state.city_code,business_provider:'BASE_EMPRESARIAL',geography_provider:state.geography_provider||null,geography_preprocessor:state.geography_preprocessor||null,source_attempts:state.source_attempts,geography_scope:'COMPANY_ESTABLISHMENT',segment_rule:context.segment_rule,segment_filter_applied:'CLIENT_CNAE_VALIDATION',transformations:['NAME_NORMALIZATION','SURNAME_TOKEN','EXACT_CITY_STATE_RESOLUTION','CITY_COMPANY_SCAN','CNAE_CLIENT_VALIDATION'],coverage:'Estabelecimentos no município consultado; nome empresarial e QSA são pistas, sem confirmar parentesco ou residência.'}}
 function finish(blocked=false){
  state.last_error=notes.at(-1)||null;
  state.coverage_incomplete=state.coverage_incomplete||reviewIncomplete;
  const complete=!blocked&&!failed&&!state.coverage_incomplete&&!state.candidate_limit_reached&&state.listing_exhausted&&!state.backlog.length&&!state.qsa_incomplete_roots.length;
  const status=blocked?'BLOCKED':complete?'COMPLETED':failed&&!state.scanned_cnpjs.length?'FAILED':'PARTIAL';
  return {status,complete,candidates:matches,state,search_lineage:lineage(),notes,qsa_reads:qsaReads,continuation:!blocked&&(state.backlog.length>0||state.next_page!==null),source_provider:'BASE_EMPRESARIAL',fallback_eligible:failed&&transportFailed&&!fallbackBlocked};
 }
 if(state.retry_not_before&&Date.parse(state.retry_not_before)>clock()){notes.push('RATE_LIMIT_RETRY_AFTER');return finish()}
 state.retry_not_before=null;
 if(!state.city_code){
  const official=await read(`${IBGE}/estados/${context.state}/municipios`,d=>Array.isArray(d));
  if(official.ok){
   const cities=official.data.filter((r:any)=>{const uf=r?.microrregiao?.mesorregiao?.UF||r?.['regiao-imediata']?.['regiao-intermediaria']?.UF;return familyNorm(r?.nome)===familyNorm(context.city)&&uf?.sigla===context.state&&/^\d{7}$/.test(String(r.id))&&(!uf.id||String(r.id).startsWith(String(uf.id)))});
   if(cities.length!==1){notes.push('IBGE_CITY_NOT_UNIQUELY_RESOLVED');return finish(true)}
   state.city_code=String(cities[0].id);state.geography_provider='IBGE_LOCALIDADES';state.geography_preprocessor={provider:'IBGE_LOCALIDADES',source_url:`${IBGE}/estados/${context.state}/municipios`,municipality_code:state.city_code,municipality_name:text(cities[0].nome,120),state:context.state,validation:'EXACT_CITY_UF',queried_at:new Date(clock()).toISOString()};
  }else notes.push('IBGE_GEOGRAPHY_FALLBACK');
 }
 if(!state.city_code){
  if(options.baseAvailable===false){failed=true;notes.push('IBGE_GEOGRAPHY_QUERY_FAILED');return finish()}
  const uf=await read('/locations/states?filter%5Babbreviation%5D='+encodeURIComponent(context.state),d=>Array.isArray(d?.data));
  if(!uf.ok){failed=true;notes.push('STATE_QUERY_FAILED');return finish()}
  const states=uf.data.data.filter((r:any)=>text(r.abbreviation,2).toUpperCase()===context.state&&/^\d{2}$/.test(String(r.ibge_code)));
  if(states.length!==1){notes.push('STATE_NOT_RESOLVED');return finish(true)}
  const ufCode=String(states[0].ibge_code);
  let cityResult=await read('/locations/cities?filter%5Bstate_code%5D='+ufCode+'&filter%5Bname%5D='+encodeURIComponent(context.city),d=>Array.isArray(d?.data));
  if(!cityResult.ok){failed=true;notes.push('CITY_QUERY_FAILED');return finish()}
  let cities=cityResult.data.data.filter((r:any)=>familyNorm(r.name)===familyNorm(context.city)&&String(r.ibge_code).startsWith(ufCode)&&/^\d{7}$/.test(String(r.ibge_code)));
  if(!cities.length){cityResult=await read('/locations/states/'+ufCode+'/cities/stats?q='+encodeURIComponent(familyNorm(context.city)),d=>Array.isArray(d?.data));if(!cityResult.ok){failed=true;notes.push('CITY_QUERY_FAILED');return finish()}cities=cityResult.data.data.filter((r:any)=>familyNorm(r.name)===familyNorm(context.city)&&String(r.ibge_code).startsWith(ufCode)&&/^\d{7}$/.test(String(r.ibge_code)))}
  if(cities.length!==1){notes.push('CITY_NOT_UNIQUELY_RESOLVED');return finish(true)}state.city_code=String(cities[0].ibge_code);state.geography_provider='BASE_EMPRESARIAL';state.geography_preprocessor={provider:'BASE_EMPRESARIAL',source_url:API+'/locations/cities',municipality_code:state.city_code,municipality_name:text(cities[0].name,120),state:context.state,validation:'EXACT_CITY_UF',queried_at:new Date(clock()).toISOString()};
 }
 if(options.geographyOnly)return finish();
 const scanned=new Set(state.scanned_cnpjs),pending=new Map(state.backlog.map(c=>[c.full_cnpj,c]));
 // Drain saved companies before fetching more pages, so continuation does not grow without bound.
 if(!pending.size&&!state.listing_exhausted){
  for(let p=0;p<3&&state.next_page!==null&&clock()<deadline-1500;p++){
   const page=state.next_page,result=await read(`/companies/search?city_id=${state.city_code}&per_page=100&sort=id&page=${page}`,d=>Array.isArray(d?.data));
   if(!result.ok){failed=true;notes.push('COMPANY_PAGE_QUERY_FAILED');break}
   for(const raw of result.data.data){const full=cnpj(raw?.full_cnpj);if(!/^[A-Z0-9]{12}\d{2}$/.test(full)||!cnae(raw?.main_cnae)||!text(raw?.corporate_name)||!text(raw?.city_name)||!/^[A-Z]{2}$/.test(text(raw?.state_abbreviation,2).toUpperCase())){reviewIncomplete=true;notes.push('INVALID_COMPANY_ROW');continue}if(scanned.has(full))continue;scanned.add(full);state.scanned_count++;if(scanned.size>500)scanned.delete(scanned.values().next().value!);const company=safeCompany(raw,context,state.city_code!);if(company&&company.company_name)pending.set(company.full_cnpj,company)}
   state.pages_scanned++;state.next_page=page+1;
   if(typeof result.data.meta?.has_more!=='boolean'){notes.push('PAGE_CONTINUATION_UNKNOWN');failed=true;state.next_page=page;break}
   if(result.data.meta.has_more===false){state.listing_exhausted=true;state.next_page=null;break}
  }
 }
 state.scanned_cnpjs=[...scanned];
 const backlog=[...pending.values()].sort((a,b)=>Number(hasSurname(b.company_name,context.surname))-Number(hasSurname(a.company_name,context.surname))||a.full_cnpj.localeCompare(b.full_cnpj));
 const processed=new Set<string>();
 for(const company of backlog)if(hasSurname(company.company_name,context.surname))matches.push({...company,entity_type:'COMPANY',match_basis:'COMPANY_NAME'});
 const roots=[...new Map(backlog.map(c=>[c.basic_cnpj,c])).values()].slice(0,16);
 for(let i=0;i<roots.length&&clock()<deadline-1500;i+=2){
  const batch=roots.slice(i,i+2);qsaReads+=batch.length;
  await Promise.all(batch.map(async company=>{
   const result=await read('/companies/'+company.basic_cnpj,d=>d?.data&&typeof d.data==='object');
   if(!result.ok||cnpj(result.data?.data?.basic_cnpj)!==company.basic_cnpj||!Array.isArray(result.data.data.partners)){
    failed=true;notes.push('QSA_QUERY_FAILED');if(result.status!==429&&result.error!=='DEADLINE')for(const related of backlog.filter(c=>c.basic_cnpj===company.basic_cnpj)){related.attempts=(related.attempts||0)+1;if(related.attempts>=2){processed.add(related.full_cnpj);state.qsa_incomplete_roots.push(company.basic_cnpj)}}return;
   }
   const partners=result.data.data.partners;
   if(partners.length>100||result.data.meta?.partners_truncated===true||result.data.data.partners_truncated===true){reviewIncomplete=true;state.qsa_incomplete_roots.push(company.basic_cnpj);notes.push('QSA_COVERAGE_LIMIT')}
   for(const partner of partners.slice(0,100)){
    if(!partner||typeof partner!=='object'||!text(partner.partner_name)||!['1','2','3'].includes(String(partner.partner_identifier?.code))){reviewIncomplete=true;notes.push('INVALID_QSA_ROW');continue}
    if(partner.name_redacted===true||partner.is_legal_entity!==false||String(partner.partner_identifier?.code)!=='2'||!hasSurname(partner.partner_name,context.surname)||familyNorm(partner.partner_name)===familyNorm(context.lead_name))continue;
    for(const related of backlog.filter(c=>c.basic_cnpj===company.basic_cnpj))matches.push({...related,entity_type:'PERSON',person_name:text(partner.partner_name),match_basis:'QSA_PERSON',partner_role:text(partner.role||partner.partner_qualification?.name,120)});
   }
   for(const related of backlog.filter(c=>c.basic_cnpj===company.basic_cnpj))processed.add(related.full_cnpj);
  }));
 }
 state.qsa_incomplete_roots=[...new Set(state.qsa_incomplete_roots)].slice(0,500);state.backlog=backlog.filter(c=>!processed.has(c.full_cnpj)).slice(0,500);
 const unique=[...new Map(matches.map(m=>[m.entity_type+'|'+familyNorm(m.person_name||m.company_name)+'|'+m.full_cnpj,m])).values()];if(unique.length>60){state.candidate_limit_reached=true;notes.push('CANDIDATE_COVERAGE_LIMIT_60')}matches.splice(0,matches.length,...unique.slice(0,60));
 return finish();
}
