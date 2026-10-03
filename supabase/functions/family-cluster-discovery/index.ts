import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import {createClient} from 'jsr:@supabase/supabase-js@2';
import {familyContext,familyNorm,familyStableId,familyQueryFingerprint,familyResumeState,discoverFamilyContext} from '../_shared/family-discovery.ts';
import {persistSourceEvidence} from '../_shared/source-evidence.ts';
const H={'Content-Type':'application/json','Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type','Access-Control-Allow-Methods':'POST, OPTIONS'};
const reply=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:H});
const BASE_PROXY='https://valora-proxy-git-max-v1-contatoguilhermegsantos-6547s-projects.vercel.app/api/source/base-empresarial';
function baseFallback(auth:string){
 const configured=Deno.env.get('BASE_EMPRESARIAL_PROXY_URL')||BASE_PROXY;
 // Forward the verified user's bearer only to this owned branch endpoint.
 if(configured!==BASE_PROXY)return undefined;
 return async(path:string,valid:(d:any)=>boolean,options:{timeoutMs:number})=>{
  const url=new URL(path,'https://app.baseempresarial.com.br/api/v1'),basic=path.match(/^\/companies\/([A-Z0-9]{8})$/)?.[1];let body:any;
  if(url.pathname==='/companies/search'&&/^\d{7}$/.test(url.searchParams.get('city_id')||'')&&/^\d+$/.test(url.searchParams.get('page')||''))body={operation:'companies_search',city_id:url.searchParams.get('city_id'),page:Number(url.searchParams.get('page')),timeout_ms:Math.max(1000,options.timeoutMs-500)};
  else if(basic)body={operation:'company_detail',basic_cnpj:basic,timeout_ms:Math.max(1000,options.timeoutMs-500)};
  else return {ok:false,status:400,data:null,error:'UNSUPPORTED_OPERATION'};
  try{
   const response=await fetch(configured,{method:'POST',headers:{Authorization:auth,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(options.timeoutMs)});
   if(!response.ok){const header=response.headers.get('Retry-After')||'60',retry=/^\d+$/.test(header)?Number(header):Math.max(0,(Date.parse(header)-Date.now())/1000)||60;await response.body?.cancel();return {ok:false,status:response.status,data:null,error:'HTTP_'+response.status,retry_after_seconds:response.status===429?retry:undefined}}
   let data:any;try{data=await response.json()}catch{return {ok:false,status:response.status,data:null,error:'INVALID_RESPONSE'}}
   return valid(data)?{ok:true,status:response.status,data,error:null}:{ok:false,status:response.status,data:null,error:'INVALID_RESPONSE'};
  }catch(e){return {ok:false,status:null,data:null,error:e instanceof Error&&['AbortError','TimeoutError'].includes(e.name)?'TIMEOUT':'NETWORK_ERROR'}}
 };
}
Deno.serve(async(req:Request)=>{
 if(req.method==='OPTIONS')return reply({ok:true});if(req.method!=='POST')return reply({error:'POST required'},405);
 const auth=req.headers.get('Authorization');if(!auth)return reply({error:'Unauthorized'},401);
 const base=Deno.env.get('SUPABASE_URL')!,admin=createClient(base,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!),client=createClient(base,Deno.env.get('SUPABASE_ANON_KEY')!,{global:{headers:{Authorization:auth}}});
 const session=await client.auth.getUser(),user=session.data?.user;if(session.error||!user)return reply({error:'Unauthorized'},401);
 const raw=await req.json().catch(()=>null);if(!raw||typeof raw!=='object'||Array.isArray(raw))return reply({error:'JSON object required'},400);
 const leadId=String(raw.lead_id||''),runId=raw.research_run_id?String(raw.research_run_id):null;
 if(!/^[0-9a-f-]{36}$/i.test(leadId)||runId&&!/^[0-9a-f-]{36}$/i.test(runId))return reply({error:'Valid lead_id and research_run_id required'},400);
 const profile=await admin.from('profiles').select('active_organization_id').eq('id',user.id).maybeSingle();if(profile.error)return reply({error:'Could not validate organization'},500);
 const org=profile.data?.active_organization_id;if(!org)return reply({error:'No active organization'},409);
 const membership=await admin.from('organization_members').select('role,status').eq('organization_id',org).eq('user_id',user.id).maybeSingle();if(membership.error)return reply({error:'Could not validate membership'},500);
 if(membership.data?.status!=='ACTIVE'||!['OWNER','ADMIN','ANALYST','MEMBER'].includes(membership.data.role))return reply({error:'Write access required'},403);
 const [lead,source,pivotRead]=await Promise.all([
  admin.from('leads').select('id,kind,name,city,state,segment').eq('id',leadId).eq('organization_id',org).maybeSingle(),
  admin.from('source_registry').select('id,connection_status').eq('key','base_empresarial_rfb').maybeSingle(),
  admin.from('candidate_entities').select('*').eq('lead_id',leadId).eq('organization_id',org).eq('candidate_type','FAMILY_SEARCH_PIVOT').maybeSingle()
 ]);
 if([lead,source,pivotRead].some(r=>r.error))return reply({error:'Could not load investigation context'},500);
 if(!lead.data)return reply({error:'Lead not found'},404);
 if(runId){const run=await admin.from('research_runs').select('id').eq('id',runId).eq('lead_id',leadId).eq('organization_id',org).maybeSingle();if(run.error)return reply({error:'Could not validate research run'},500);if(!run.data)return reply({error:'Research run not found'},404)}
 const context=familyContext(lead.data,raw.strategy),previous=pivotRead.data;
 if(previous?.validation_status==='REJECTED')return reply({ok:true,status:'BLOCKED',complete:false,candidates_found:0,candidates:[],pivot:previous,note:'Pivô descartado por revisão; pesquisa não reaberta automaticamente.'});
 const started=Date.now();
 try{
  const pivotId=previous?.id||await familyStableId(`family-pivot|${org}|${leadId}`);
  const fingerprint=context.ok?await familyQueryFingerprint(context):null,sourceAvailable=source.data&&['CONNECTED','CONNECTED_LIMITED'].includes(source.data.connection_status);
  const progress=raw.restart===true?{}:previous?.metadata||{};
  let result:any=context.ok&&sourceAvailable?await discoverFamilyContext(context,progress,{baseFallback:baseFallback(auth)}):{status:'BLOCKED',complete:false,candidates:[],state:context.ok?await familyResumeState(context,progress):{},search_lineage:{original:{name:lead.data.name,city:lead.data.city,state:lead.data.state,segment:lead.data.segment}},notes:[context.ok?'SOURCE_NOT_AVAILABLE':context.reason],continuation:false,qsa_reads:0};
  const candidates:any[]=[];let reviewsBlocked=0;
  for(const match of result.candidates){
   const label=match.entity_type==='PERSON'?match.person_name:match.company_name;
   const stable=await familyStableId(`family-context|${org}|${leadId}|${match.entity_type}|${familyNorm(label)}|${match.full_cnpj}`);
   const sourceUrl='https://baseempresarial.com.br/empresa/'+match.full_cnpj;
   const excerpt=match.match_basis==='QSA_PERSON'?`O nome ${match.person_name} consta no QSA da raiz ${match.basic_cnpj}, empresa ${match.company_name}. Estabelecimento consultado ${match.full_cnpj}, município/UF da empresa ${match.city}/${match.state}, CNAE principal ${match.cnae_code} — ${match.cnae_description}. Coincidência de sobrenome e contexto empresarial é uma pista; não comprova identidade individual, parentesco ou residência da pessoa.`:`Razão social ${match.company_name}; CNPJ do estabelecimento ${match.full_cnpj}; município/UF da empresa ${match.city}/${match.state}; CNAE principal ${match.cnae_code} — ${match.cnae_description}. A razão social contém o token ${context.ok?context.surname:''}; é uma pista empresarial, sem confirmação de titularidade do lead ou parentesco.`;
   const evidence=await persistSourceEvidence(admin,{organization_id:org,lead_id:leadId,source_registry_id:source.data.id,title:'Pista contextual de sobrenome — '+label,source_label:'Base Empresarial / dados públicos do CNPJ-RFB',source_url:sourceUrl,source_kind:'AGGREGATOR',document_type:'CNPJ_REGISTRY',publisher:'Base Empresarial',source_date:null,retrieved_at:new Date().toISOString(),dedupe_key:`${leadId}:family-context:${stable}`,reliability_weight:0.75,raw_reference:JSON.stringify({match_basis:match.match_basis,full_cnpj:match.full_cnpj,person_name:match.person_name||null}),excerpt,verification_status:'VERIFIED',last_verified_at:new Date().toISOString(),usage_scope:'INTERNAL',created_by:user.id});
   if(evidence.error||!evidence.data)throw new Error('Could not persist contextual source evidence');
   if(evidence.data.verification_status!=='VERIFIED'){reviewsBlocked++;continue}
   const metadata={query_fingerprint:fingerprint,surname:context.ok?context.surname:null,person_name:match.person_name||null,partner_role:match.partner_role||null,company_name:match.company_name,full_cnpj:match.full_cnpj,basic_cnpj:match.basic_cnpj,city:match.city,state:match.state,segment:lead.data.segment,cnae_code:match.cnae_code,cnae_description:match.cnae_description,match_basis:match.match_basis,evidence_id:evidence.data.id,evidence_status:evidence.data.verification_status,source_url:sourceUrl,queried_at:new Date().toISOString(),kinship_confirmed:false,geography_scope:'COMPANY_ESTABLISHMENT',context_matches:{surname_token:true,company_city:true,company_state:true,company_activity:true},search_lineage:result.search_lineage};
   // Insert once, including when a user review races this request. Never overwrite reviews.
   const inserted=await admin.from('candidate_entities').upsert({id:stable,organization_id:org,lead_id:leadId,research_run_id:runId,entity_type:match.entity_type,label,candidate_reason:'Coincidência de sobrenome, município/UF e atividade da empresa. Pista contextual a investigar; parentesco não confirmado.',candidate_type:'FAMILY_CONTEXT_MATCH',confidence:'LOW',validation_status:'UNVALIDATED',metadata,created_by:user.id},{onConflict:'id',ignoreDuplicates:true});
   if(inserted.error)throw new Error('Could not persist contextual candidate');
   const actual=await admin.from('candidate_entities').select('*').eq('id',stable).eq('organization_id',org).eq('lead_id',leadId).maybeSingle();if(actual.error||!actual.data)throw new Error('Could not validate candidate review');
   if(actual.data.validation_status==='REJECTED'||actual.data.metadata?.query_fingerprint!==fingerprint){reviewsBlocked++;continue}candidates.push(actual.data);
  }
  if(reviewsBlocked&&result.status==='COMPLETED'){result={...result,status:'PARTIAL',complete:false}}
  const count=await admin.from('candidate_entities').select('id,metadata').eq('organization_id',org).eq('lead_id',leadId).eq('candidate_type','FAMILY_CONTEXT_MATCH').neq('validation_status','REJECTED');if(count.error||!Array.isArray(count.data))throw new Error('Could not count contextual candidates');
  const candidatesFound=fingerprint?count.data.filter((c:any)=>c.metadata?.query_fingerprint===fingerprint).length:0;
  const metadata={...(result.state||{}),surname:context.ok?context.surname:null,city:lead.data.city,state:lead.data.state,segment:lead.data.segment,segment_rule:context.ok?context.segment_rule:null,search_status:result.status==='COMPLETED'?'COMPLETE':result.status,complete:result.complete,scanned_count:result.state?.scanned_count||0,candidates_found:candidatesFound,continuation:Boolean(result.continuation),qsa_reads:result.qsa_reads,review_blocked_count:reviewsBlocked,coverage_limits:{pages_per_run:3,companies_per_page:100,recent_cnpj_checkpoint:500,qsa_roots_per_run:16,qsa_parallelism:2,candidates_per_run:60,source_query_deadline_ms:45000,geography_scope:'COMPANY_ESTABLISHMENT',kinship_confirmed:false},search_lineage:result.search_lineage,last_queried_at:new Date().toISOString(),notes:result.notes};
  const pivotPayload={id:pivotId,organization_id:org,lead_id:leadId,research_run_id:runId,entity_type:'GROUP',label:`Pivô de sobrenome ${context.ok?context.surname:'a validar'} em ${lead.data.city||'município a validar'}`,candidate_reason:'Busca contextual empresarial. Sobrenome, localidade e segmento não comprovam parentesco.',candidate_type:'FAMILY_SEARCH_PIVOT',confidence:'LOW',validation_status:'UNVALIDATED',metadata,created_by:user.id};
  if(!previous){const insert=await admin.from('candidate_entities').upsert(pivotPayload,{onConflict:'id',ignoreDuplicates:true});if(insert.error)throw new Error('Could not persist search pivot')}
  const updated=await admin.from('candidate_entities').update({metadata,research_run_id:runId}).eq('id',pivotId).eq('organization_id',org).eq('lead_id',leadId).eq('validation_status','UNVALIDATED').select('*').maybeSingle();if(updated.error||!updated.data)throw new Error('Pivot review prevents progress update');
  const log=await admin.from('source_fetch_logs').insert({organization_id:org,research_run_id:runId,source_registry_id:source.data?.id||null,endpoint_reference:'IBGE municipalities or Base geography -> Base companies/search city_id -> companies/{basic}/QSA',success:['COMPLETED','PARTIAL'].includes(result.status),http_status:result.status==='FAILED'?null:200,result_status:'FAMILY_CONTEXT_'+result.status,duration_ms:Date.now()-started,created_by:user.id});if(log.error)throw new Error('Could not persist discovery result');
  return reply({ok:result.status!=='FAILED',status:result.status,complete:result.complete,candidates_found:candidatesFound,candidates,search_lineage:result.search_lineage,pivot:updated.data,note:'Pistas cadastrais da empresa; parentesco, residência e identidade individual não confirmados.'},result.status==='FAILED'?502:200);
 }catch{return reply({ok:false,status:'FAILED',complete:false,error:'Could not complete or persist contextual discovery; previous reviews preserved'},500)}
});
