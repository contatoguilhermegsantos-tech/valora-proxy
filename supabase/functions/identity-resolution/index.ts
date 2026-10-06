import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {createClient} from "jsr:@supabase/supabase-js@2";
import {assessIdentity} from "./policy.ts";
import {validQsaDiscoveryEvidence} from "../_shared/qsa-evidence.ts";

const H={"Content-Type":"application/json","Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS"};
const uuid=(v:unknown)=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const reply=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:H});
const rpcStatus=(code:unknown)=>({42501:403,P0002:404,22023:400,P0001:409} as Record<string,number>)[String(code)]||500;

Deno.serve(async(req:Request)=>{
 if(req.method==='OPTIONS')return new Response('ok',{headers:H});
 if(req.method!=='POST')return reply({error:'POST required'},405);
 const auth=req.headers.get('Authorization')||'';if(!auth)return reply({error:'Unauthorized'},401);
 try{
  const url=Deno.env.get('SUPABASE_URL')!,anon=Deno.env.get('SUPABASE_ANON_KEY')!,service=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const uc=createClient(url,anon,{global:{headers:{Authorization:auth}}}),admin=createClient(url,service);
  const session=await uc.auth.getUser(),user=session.data?.user;if(session.error||!user)return reply({error:'Unauthorized'},401);
  const b=await req.json().catch(()=>null);
  if(!b||typeof b!=='object'||Array.isArray(b)||!uuid(b.lead_id)||b.research_run_id!=null&&!uuid(b.research_run_id))return reply({error:'Valid lead_id and research_run_id required'},400);
  const leadId=b.lead_id,runId=b.research_run_id||null;
  const p=await admin.from('profiles').select('active_organization_id').eq('id',user.id).maybeSingle();if(p.error)throw Error('Profile read failed');
  const orgId=p.data?.active_organization_id;if(!orgId)return reply({error:'No active organization'},409);
  const member=await admin.from('organization_members').select('role,status').eq('organization_id',orgId).eq('user_id',user.id).maybeSingle();if(member.error)throw Error('Membership read failed');
  if(member.data?.status!=='ACTIVE'||!['OWNER','ADMIN','ANALYST','MEMBER'].includes(member.data.role))return reply({error:'Operator access required'},403);
  const loaded=await admin.from('leads').select('*').eq('id',leadId).eq('organization_id',orgId).maybeSingle();if(loaded.error)throw Error('Lead read failed');
  const lead=loaded.data;if(!lead)return reply({error:'Lead not found'},404);
  if(lead.kind!=='PERSON')return reply({error:'QSA identity resolution requires a person lead'},409);
  if(runId){const run=await admin.from('research_runs').select('id').eq('id',runId).eq('organization_id',orgId).eq('lead_id',leadId).maybeSingle();if(run.error)throw Error('Run read failed');if(!run.data)return reply({error:'Research run not found'},404)}

  const attempts:any[]=[];
  async function recordAttempt(sourceKey:string,sequenceNo:number,status:string,resultSummary:string,metadata:any={}){
   const saved=await admin.from('identity_source_attempts').insert({organization_id:orgId,lead_id:leadId,research_run_id:runId,source_key:sourceKey,sequence_no:sequenceNo,status,result_summary:resultSummary,metadata,created_by:user.id}).select('id').single();
   if(saved.error||!saved.data?.id)throw Error('Source attempt persistence failed');
   attempts.push({id:saved.data.id,source_key:sourceKey,sequence_no:sequenceNo,status,result_summary:resultSummary,metadata});
  }
  async function invoke(name:string,body:any){
   try{
    const response=await fetch(url+'/functions/v1/'+name,{method:'POST',signal:AbortSignal.timeout(25000),headers:{Authorization:auth,'Content-Type':'application/json'},body:JSON.stringify(body)});
    const data=await response.json().catch(()=>null);
    return {ok:response.ok&&!!data&&typeof data==='object'&&!Array.isArray(data)&&data.ok!==false,status:response.status,data,error:!data?'INVALID_RESPONSE':response.ok?null:'UPSTREAM_HTTP_ERROR'};
   }catch{return {ok:false,status:null,data:null,error:'SOURCE_UNAVAILABLE'}}
  }
  async function loadCandidates(){
   const result=await admin.from('candidate_entities').select('*').eq('organization_id',orgId).eq('lead_id',leadId).eq('candidate_type','RFB_QSA_NAME_MATCH').neq('validation_status','REJECTED');
   if(result.error)throw Error('Candidate read failed');return result.data||[];
  }

  let discovery:any=null;
  if(b.run_discovery!==false&&lead.kind==='PERSON'){
   const result=await invoke('name-company-discovery',{lead_id:leadId,research_run_id:runId});discovery=result.data;
   const n=Number(result.data?.candidates_found||0);
   const completed=result.ok&&result.data?.complete!==false;
   await recordAttempt('base_empresarial_rfb',1,result.ok&&n>0?'CANDIDATES_FOUND':completed?'NO_MATCH':'FAILED',result.ok&&n>0?n+' candidato(s) societário(s) localizado(s) pelo nome.':completed?'Nenhum candidato societário localizado no recorte consultado.':'A descoberta por nome não foi concluída.',{candidates_found:result.ok?n:0,http_status:result.status,error:result.error,complete:completed});
  }
  let candidates=await loadCandidates();
  if(b.run_discovery===false){const n=candidates.length;await recordAttempt('base_empresarial_rfb',1,n>0?'CANDIDATES_FOUND':'NO_MATCH',n>0?n+' candidato(s) existentes encontrados; os documentos serão revalidados antes da pontuação.':'Nenhum candidato societário disponível após a descoberta por nome.',{candidates_found:n,reused:true})}
  if(candidates.length>=2){
   const result=await invoke('cross-validate-identity-links',{lead_id:leadId,research_run_id:runId});
   const groups=result.ok&&Array.isArray(result.data?.groups)?result.data.groups:[],matched=groups.reduce((s:number,g:any)=>s+Number(g?.size||0),0);
   const completed=result.ok&&result.data?.complete!==false;
   await recordAttempt('brasilapi_cnpj_cross',2,result.ok&&matched>0?'CANDIDATES_FOUND':completed?'NO_MATCH':'FAILED',result.ok&&matched>0?matched+' vínculo(s) empresarial(is) com validação cruzada documental.':completed?'Nenhum agrupamento cruzado conclusivo foi produzido no recorte consultado.':'A validação cruzada de identidade não foi concluída.',{groups:groups.map((g:any)=>({group_id:g.group_id,size:g.size,anchor_confirmed:Boolean(g.anchor_confirmed)})),candidates_checked:result.data?.candidates_checked||0,http_status:result.status,error:result.error,complete:completed});
   if(result.ok)candidates=await loadCandidates();
  }

  // Consume only the cited discovery occurrence, scoped to this lead. A newer document cannot repair a stale binding.
  const evidenceIds=[...new Set(candidates.map((c:any)=>c.metadata?.evidence_id).filter(uuid))];
  let documents:any[]=[];
  if(evidenceIds.length){const result=await admin.from('evidence').select('id,organization_id,lead_id,source_registry_id,verification_status,document_type,source_url,raw_reference').eq('organization_id',orgId).eq('lead_id',leadId).in('id',evidenceIds);if(result.error)throw Error('Discovery document read failed');documents=result.data||[]}
  const sourceIds=[...new Set(documents.map(d=>d.source_registry_id).filter(uuid))];let sources:any[]=[];
  if(sourceIds.length){const result=await admin.from('source_registry').select('id,key').in('id',sourceIds);if(result.error)throw Error('Discovery registry read failed');sources=result.data||[]}
  const documentById=new Map(documents.map(d=>[d.id,d])),sourceById=new Map(sources.map(s=>[s.id,s.key]));
  const binding=new Map(candidates.map((c:any)=>{const doc:any=documentById.get(c.metadata?.evidence_id);return [c.id,validQsaDiscoveryEvidence(c,lead,doc,String(sourceById.get(doc?.source_registry_id)||''))]}));
  const eligible=candidates.filter((c:any)=>c.validation_status==='CONFIRMED'||binding.get(c.id));
  const assessed=assessIdentity(lead,eligible),{top,ambiguousCandidateIds}=assessed;
  const scored:any[]=[...assessed.scored.map((x:any)=>({...x,factors:{...x.factors,evidence_binding_valid:binding.get(x.candidate.id)===true}})),...candidates.filter((c:any)=>!eligible.includes(c)).map((candidate:any)=>({candidate,score:0,decision:'REVIEW',factors:{evidence_binding_valid:false,reason:'DISCOVERY_DOCUMENT_REVIEW_REQUIRED'}}))];

  if(b.run_fallback===true&&lead.kind==='PERSON'&&(!top||top.score<75||assessed.ambiguous)){
   if(lead.city){
    const result=await invoke('querido-diario-search',{lead_id:leadId,max_results:8,research_run_id:runId,terms:[lead.name]});
    const n=Number(result.data?.mentions_found||0),status=result.data?.territory_found===false?'NOT_COVERED':n>0?'MENTIONS_FOUND':'NO_MATCH';
    await recordAttempt('querido_diario',3,result.ok?status:'FAILED',result.ok?(status==='NOT_COVERED'?'Município fora da cobertura localizada do Querido Diário.':n>0?n+' menção(ões) pública(s) localizada(s) para validação contextual.':'Nenhuma menção localizada no recorte municipal consultado.'):'A consulta contextual municipal não foi concluída.',{territory_id:result.data?.territory_id||null,mentions_found:n,http_status:result.status,error:result.error,complete:result.data?.complete===true});
   }else await recordAttempt('querido_diario',3,'SKIPPED','Cidade não informada; fallback municipal não foi executado.');
   if(String(lead.state||'').toUpperCase()==='SP')await recordAttempt('jucesp',4,'MANUAL_REQUIRED','JUCESP permanece como rota oficial de validação societária/histórica; automação robusta ainda não conectada.',{action_url:'https://www.jucesponline.sp.gov.br/'});
   await recordAttempt('dou',5,'MANUAL_REQUIRED','DOU permanece como rota documental oficial complementar; correspondência nominal precisa ser validada no documento.',{action_url:'https://www.in.gov.br/consulta'});
   const result=await invoke('web-context-search',{lead_id:leadId,research_run_id:runId}),n=Number(result.data?.results_found||0);
   await recordAttempt('web_search',6,result.ok?(n>0?'CANDIDATES_FOUND':'NO_MATCH'):result.status===428?'CONFIG_REQUIRED':'FAILED',result.ok?(n>0?n+' resultado(s) web contextual(is) persistido(s) como candidatos; nenhum snippet foi promovido a fato.':'Nenhum resultado web contextual persistido nesta consulta.'):result.status===428?'Conector web requer configuração do provedor.':'A consulta web contextual não foi concluída.',{provider:result.data?.provider||'BRAVE',results_found:result.ok?n:0,http_status:result.status,error:result.error});
  }

  const output:any[]=[],skipped:any[]=[];
  for(const x of scored){
   const isAmbiguous=ambiguousCandidateIds.has(x.candidate.id)&&x.decision!=='CONFIRMED',decision=isAmbiguous?'AMBIGUOUS':x.decision;
   const factors={...x.factors,ambiguous:isAmbiguous};
   // The RPC locks the current review and document, checks both CAS fields, and commits assessment + candidate + lead together.
   const saved=await admin.rpc('assess_qsa_name_candidate',{p_org:orgId,p_user:user.id,p_candidate:x.candidate.id,p_expected_status:x.candidate.validation_status,p_expected_meta:x.candidate.metadata||{},p_score:x.score,p_decision:decision,p_factors:factors,p_run:runId});
   if(saved.error)return reply({error:'Identity assessment could not be committed; existing reviews were preserved'},rpcStatus(saved.error.code));
   const result=saved.data;if(!result||typeof result.applied!=='boolean')throw Error('Invalid assessment result');
   if(!result.applied){skipped.push({candidate_id:x.candidate.id,validation_status:result.validation_status||null,reason:'CONCURRENT_REVIEW_OR_CONTEXT_CHANGED'});continue}
   if(!uuid(result.assessment_id)||!Number.isInteger(result.score)||!['CONFIRMED','SUPPORTED','AMBIGUOUS','REVIEW','WEAK'].includes(result.decision))throw Error('Assessment readback missing');
   output.push({assessment_id:result.assessment_id,candidate_id:x.candidate.id,label:x.candidate.label,score:result.score,decision:result.decision,confidence:result.score>=75?'HIGH':result.score>=45?'MEDIUM':'LOW',validation_status:result.validation_status,factors:result.score===0&&result.decision==='REVIEW'?{evidence_binding_valid:false,ambiguous:false,reason:'DISCOVERY_DOCUMENT_REVIEW_REQUIRED'}:factors});
  }
  // Recompute under the lead lock even when every candidate was rejected or changed during this request.
  const refreshed=await admin.rpc('refresh_qsa_identity_status',{p_org:orgId,p_user:user.id,p_lead:leadId});
  if(refreshed.error||refreshed.data?.ok!==true||typeof refreshed.data.lead_status!=='string')throw Error('Lead status refresh failed');
  // Never derive a new lead status from this request's old candidate snapshot.
  const fresh=await admin.from('leads').select('id,identity_status,identity_confirmed_by_user').eq('id',leadId).eq('organization_id',orgId).maybeSingle();if(fresh.error||!fresh.data)throw Error('Lead status readback failed');
  return reply({ok:true,lead_id:leadId,lead_status:fresh.data.identity_status,ambiguity:output.some(x=>x.decision==='AMBIGUOUS'),candidates_assessed:output.length,candidates:output,assessments_skipped:skipped,discovery_note:discovery?.caveat||discovery?.note||null,source_attempts:attempts,rule:'SUPPORTED é suporte algorítmico sustentado por documento de descoberta verificado. VERIFIED exige confirmação explícita do usuário ou fluxo equivalente documentado.'});
 }catch{return reply({error:'Não foi possível validar ou registrar a resolução de identidade.'},500)}
});
