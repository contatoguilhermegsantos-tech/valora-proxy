import type {FamilyState,FamilyContext,FamilyMatch} from './family-discovery.ts';

const API='https://minhareceita.org';
const norm=(value:unknown)=>String(value??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().replace(/[^A-Z0-9 ]/g,' ').replace(/\s+/g,' ').trim();
const text=(value:unknown,max=255)=>String(value??'').trim().slice(0,max);
const cnpj=(value:unknown)=>String(value??'').toUpperCase().replace(/[^A-Z0-9]/g,'');
const cnae=(value:unknown)=>{const digits=String(value??'').replace(/\D/g,'');return digits.length>0&&digits.length<=7?digits.padStart(7,'0'):''};
const surname=(name:unknown,token:string)=>norm(name).split(' ').includes(token);

async function boundedJson(response:Response){
 const reader=response.body?.getReader();if(!reader)throw new Error('INVALID_RESPONSE');
 const chunks:Uint8Array[]=[];let size=0;
 try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>2*1024*1024)throw new Error('RESPONSE_TOO_LARGE');chunks.push(value)}}catch(error){await reader.cancel().catch(()=>{});throw error}finally{reader.releaseLock()}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length}
 try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))}catch{throw new Error('INVALID_RESPONSE')}
}

// The city query returns company records with QSA inline. Copy only this allowlist.
function company(raw:any,context:FamilyContext,cityCode:string){
 const full=cnpj(raw?.cnpj),code=cnae(raw?.cnae_fiscal),city=text(raw?.municipio,120),state=text(raw?.uf,2).toUpperCase(),name=text(raw?.razao_social);
 if(!/^[A-Z0-9]{12}\d{2}$/.test(full)||!code||!city||!/^[A-Z]{2}$/.test(state)||!name||!/^\d{7}$/.test(String(raw?.codigo_municipio_ibge)))return {invalid:true as const};
 if(norm(city)!==norm(context.city)||state!==context.state||String(raw.codigo_municipio_ibge)!==cityCode||!context.segment_rule.codes.includes(code)&&!context.segment_rule.prefixes.some(prefix=>code.startsWith(prefix)))return {excluded:true as const};
 return {value:{full_cnpj:full,basic_cnpj:full.slice(0,8),company_name:name,city,state,cnae_code:code,cnae_description:text(raw.cnae_fiscal_descricao)}};
}

export async function discoverMinhaFamily(context:FamilyContext,progress:FamilyState,options:{fetcher?:typeof fetch;now?:()=>number;deadline:number}){
 const clock=options.now||Date.now,fetcher=options.fetcher||fetch;
 const resume=progress.source_provider==='MINHA_RECEITA';
 const state:FamilyState={...progress,source_provider:'MINHA_RECEITA',scanned_cnpjs:resume?progress.scanned_cnpjs:[],scanned_count:resume?progress.scanned_count:0,backlog:[],qsa_incomplete_roots:[],pages_scanned:resume?progress.pages_scanned:0,next_page:resume?progress.next_page:1,listing_exhausted:resume&&progress.listing_exhausted,source_cursor:resume?progress.source_cursor||null:null,source_cursor_stalled:resume&&progress.source_cursor_stalled===true,coverage_incomplete:resume&&progress.coverage_incomplete,candidate_limit_reached:resume&&progress.candidate_limit_reached,last_error:null,source_attempts:progress.source_attempts||[]};
 const candidates:FamilyMatch[]=[],notes:string[]=[];let failed=false;
 const scanned=new Set(state.scanned_cnpjs);
 const previousDate=resume&&/^\d{4}-\d{2}$/.test(String(progress.source_data_month))?progress.source_data_month:null;
 state.source_data_month=previousDate;
 if(!resume)notes.push('SOURCE_PROVIDER_SWITCH_RESTARTED');
 function finish(){
  state.scanned_cnpjs=[...scanned];state.last_error=notes.at(-1)||null;
  // Beta pagination and monthly secondary coverage remain explicitly partial.
  const lineage={original:{name:context.lead_name,city:context.city,state:context.state,segment:context.segment},query_surname:context.surname,geographic_filter_applied:Boolean(state.city_code),city_code:state.city_code,geography_provider:state.geography_provider||null,geography_preprocessor:state.geography_preprocessor||null,source_attempts:state.source_attempts,source_provider:'MINHA_RECEITA',source_experimental:true,source_data_month:state.source_data_month||null,provider_listing_exhausted:state.listing_exhausted,geography_scope:'COMPANY_ESTABLISHMENT',segment_rule:context.segment_rule,segment_filter_applied:'CLIENT_CNAE_VALIDATION',transformations:['EXACT_CITY_STATE_RESOLUTION','CITY_COMPANY_SCAN','CNAE_CLIENT_VALIDATION','SURNAME_TOKEN'],coverage:'Fonte secundária mensal; busca paginada experimental. Cadastro empresarial e QSA são pistas, sem confirmar parentesco, identidade individual ou residência.'};
  return {status:failed&&state.scanned_count===0?'FAILED':'PARTIAL',complete:false,candidates,state,search_lineage:lineage,notes,qsa_reads:0,continuation:!state.listing_exhausted&&!state.source_cursor_stalled,source_provider:'MINHA_RECEITA'};
 }
 if(!state.city_code){failed=true;notes.push('CITY_REQUIRED');return finish()}
 if(state.retry_not_before&&Date.parse(state.retry_not_before)>clock()){notes.push('RATE_LIMIT_RETRY_AFTER');return finish()}
 if(state.source_cursor_stalled){notes.push('CURSOR_DID_NOT_ADVANCE');return finish()}
 state.retry_not_before=null;
 for(let page=0;page<3&&!state.listing_exhausted&&clock()<options.deadline-1200;page++){
  const url=new URL(API+'/');url.searchParams.set('municipio',state.city_code);url.searchParams.set('uf',context.state);url.searchParams.set('limit','100');if(state.source_cursor)url.searchParams.set('cursor',state.source_cursor);
  const started=clock();let status:number|null=null,error:string|null=null,data:any;
  try{
   const response=await fetcher(url.toString(),{redirect:'error',headers:{Accept:'application/json','User-Agent':'MAX-Intelligence/1.0'},signal:AbortSignal.timeout(Math.min(6000,Math.max(300,options.deadline-clock()-600)))});status=response.status;
   if(!response.ok){if(status===429){const header=response.headers.get('Retry-After')||'60',seconds=/^\d+$/.test(header)?Number(header):Math.max(0,(Date.parse(header)-clock())/1000)||60;state.retry_not_before=new Date(clock()+Math.max(1,seconds)*1000).toISOString()}await response.body?.cancel();throw new Error('HTTP_'+status)}
   data=await boundedJson(response);
   if(!Array.isArray(data?.data)||data.data.length>100||data.cursor!=null&&(typeof data.cursor!=='string'||!data.cursor||data.cursor.length>1024))throw new Error('INVALID_RESPONSE');
  }catch(caught){error=caught instanceof Error&&['TimeoutError','AbortError'].includes(caught.name)?'TIMEOUT':caught instanceof Error&&['INVALID_RESPONSE','RESPONSE_TOO_LARGE'].includes(caught.message)?caught.message:status!=null?'HTTP_'+status:'NETWORK_ERROR'}
  state.source_attempts!.push({provider:'MINHA_RECEITA',transport:'DIRECT',endpoint:'MINHA /municipal-company-scan',status,error,duration_ms:Math.max(0,clock()-started)});
  if(error){failed=true;notes.push(error==='HTTP_429'?'RATE_LIMIT_RETRY_AFTER':'MINHA_COMPANY_PAGE_QUERY_FAILED');break}
  for(const raw of data.data){
   const safe=company(raw,context,state.city_code);if('invalid'in safe){state.coverage_incomplete=true;notes.push('INVALID_COMPANY_ROW');continue}
   const full=cnpj(raw.cnpj);if(scanned.has(full))continue;scanned.add(full);state.scanned_count++;if(scanned.size>500)scanned.delete(scanned.values().next().value!);
   if('excluded'in safe)continue;
   const observed=safe.value;if(surname(observed.company_name,context.surname))candidates.push({...observed,entity_type:'COMPANY',match_basis:'COMPANY_NAME',source_provider:'MINHA_RECEITA'});
   if(!Array.isArray(raw.qsa)){state.coverage_incomplete=true;notes.push('INVALID_QSA_ROWS');continue}
   if(raw.qsa.length>100){state.coverage_incomplete=true;notes.push('QSA_COVERAGE_LIMIT')}
   for(const partner of raw.qsa.slice(0,100)){
    if(!partner||typeof partner!=='object'||![1,2,3].includes(Number(partner.identificador_de_socio))){state.coverage_incomplete=true;notes.push('INVALID_QSA_ROW');continue}
    const name=text(partner.nome_socio),usefulTokens=norm(name).split(' ').filter(token=>token&&!['DA','DAS','DE','DO','DOS','E'].includes(token));
    if(Number(partner.identificador_de_socio)!==2||!name||/[*#]|\b(REDACTED|OCULTADO|SUPRIMIDO|ANONIMIZADO)\b/i.test(name)||usefulTokens.length<2||partner.nome_ocultado===true||partner.name_redacted===true||!surname(name,context.surname)||norm(name)===norm(context.lead_name))continue;
    candidates.push({...observed,entity_type:'PERSON',person_name:text(partner.nome_socio),partner_role:text(partner.qualificacao_socio,120),match_basis:'QSA_PERSON',source_provider:'MINHA_RECEITA'});
   }
  }
  const previousCursor=state.source_cursor;state.source_cursor=data.cursor??null;state.pages_scanned++;state.listing_exhausted=state.source_cursor===null;state.next_page=state.listing_exhausted?null:state.pages_scanned+1;
  if(!state.listing_exhausted&&previousCursor===state.source_cursor){state.coverage_incomplete=true;state.source_cursor_stalled=true;notes.push('CURSOR_DID_NOT_ADVANCE');break}
 }
 const unique=[...new Map(candidates.map(c=>[c.entity_type+'|'+norm(c.person_name||c.company_name)+'|'+c.full_cnpj,c])).values()];if(unique.length>60){state.candidate_limit_reached=true;notes.push('CANDIDATE_COVERAGE_LIMIT_60')}candidates.splice(0,candidates.length,...unique.slice(0,60));
 return finish();
}
