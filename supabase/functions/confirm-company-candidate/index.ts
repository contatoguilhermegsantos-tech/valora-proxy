
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const H={"Content-Type":"application/json","Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS"};
const uuid=(v:unknown)=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const reviewStatus=(code:unknown)=>({42501:403,P0002:404,22023:400,P0001:409} as Record<string,number>)[String(code)]||500;
const cnpjNorm=(v:unknown)=>String(v??"").toUpperCase().replace(/[^A-Z0-9]/g,"");
const personNorm=(v:unknown)=>String(v??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().replace(/[^A-Z0-9 ]/g,' ').replace(/\s+/g,' ').trim();
const isValidCnpj=(v:unknown)=>{const c=cnpjNorm(v);if(!/^[A-Z0-9]{12}[0-9]{2}$/.test(c)||/^(\d)\1{13}$/.test(c))return false;const val=(x:string)=>x.charCodeAt(0)-48;const calc=(base:string,w:number[])=>{const sum=[...base].reduce((a,ch,i)=>a+val(ch)*w[i],0),r=sum%11;return r<2?0:11-r};const d1=calc(c.slice(0,12),[5,4,3,2,9,8,7,6,5,4,3,2]);return d1===Number(c[12])&&calc(c.slice(0,12)+String(d1),[6,5,4,3,2,9,8,7,6,5,4,3,2])===Number(c[13])};

Deno.serve(async(req:Request)=>{
  if(req.method==="OPTIONS") return new Response("ok",{headers:H});
  if(req.method!=="POST") return new Response(JSON.stringify({error:"POST required"}),{status:405,headers:H});
  const auth=req.headers.get("Authorization");
  if(!auth) return new Response(JSON.stringify({error:"Unauthorized"}),{status:401,headers:H});

  const url=Deno.env.get("SUPABASE_URL")!,anon=Deno.env.get("SUPABASE_ANON_KEY")!,service=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const uc=createClient(url,anon,{global:{headers:{Authorization:auth}}});
  const admin=createClient(url,service);
  const {data:{user}}=await uc.auth.getUser();
  if(!user) return new Response(JSON.stringify({error:"Unauthorized"}),{status:401,headers:H});

  const b=await req.json().catch(()=>({}));
  const candidateId=String(b.candidate_id||"");
  if(!uuid(candidateId)) return new Response(JSON.stringify({error:"Valid candidate_id required"}),{status:400,headers:H});

  const {data:p,error:profileError}=await admin.from("profiles").select("active_organization_id").eq("id",user.id).single();
  if(profileError)return new Response(JSON.stringify({error:'Could not validate active organization'}),{status:500,headers:H});
  const orgId=p?.active_organization_id;
  if(!orgId) return new Response(JSON.stringify({error:"No active organization"}),{status:409,headers:H});
  const {data:membership,error:membershipError}=await admin.from("organization_members").select("role,status").eq("organization_id",orgId).eq("user_id",user.id).maybeSingle();
  if(membershipError)return new Response(JSON.stringify({error:'Could not validate operator membership'}),{status:500,headers:H});
  if(membership?.status!=="ACTIVE"||!['OWNER','ADMIN','ANALYST','MEMBER'].includes(membership.role))return new Response(JSON.stringify({error:"Operator access required"}),{status:403,headers:H});
  const {data:candidate,error:candidateError}=await admin.from("candidate_entities").select("*")
  .eq("id",candidateId).eq("organization_id",orgId).maybeSingle();
  if(candidateError)return new Response(JSON.stringify({error:'Could not validate candidate review'}),{status:500,headers:H});
  if(!candidate) return new Response(JSON.stringify({error:"Candidate not found"}),{status:404,headers:H});
  if(candidate.entity_type!=="COMPANY"||!['RFB_QSA_NAME_MATCH','RFB_COMPANY_NAME_MATCH'].includes(candidate.candidate_type)) return new Response(JSON.stringify({error:"Unsupported candidate type"}),{status:400,headers:H});
  if(candidate.validation_status==='REJECTED')return new Response(JSON.stringify({error:'Rejected candidate cannot be confirmed by a routine selection'}),{status:409,headers:H});

  const cnpj=cnpjNorm(candidate.metadata?.full_cnpj);
  if(!isValidCnpj(cnpj)) return new Response(JSON.stringify({error:"Candidate has no valid numeric/alphanumeric CNPJ"}),{status:400,headers:H});

  const {data:lead,error:leadError}=await admin.from("leads").select("id,name,kind,initial_cnpj").eq("id",candidate.lead_id).eq("organization_id",orgId).maybeSingle();
  if(leadError)return new Response(JSON.stringify({error:'Could not validate candidate lead'}),{status:500,headers:H});
  if(!lead) return new Response(JSON.stringify({error:"Lead not found"}),{status:404,headers:H});

  if(candidate.candidate_type==='RFB_COMPANY_NAME_MATCH'){
    if(lead.kind!=='COMPANY'||lead.initial_cnpj&&cnpjNorm(lead.initial_cnpj)!==cnpj)return new Response(JSON.stringify({error:'Company candidate does not match the current legal identity context'}),{status:409,headers:H});
    if(!uuid(candidate.metadata?.evidence_id))return new Response(JSON.stringify({error:'Verified scoped company registry document required'}),{status:409,headers:H});
    const doc=await admin.from('evidence').select('id,verification_status,source_registry_id,document_type,raw_reference').eq('id',candidate.metadata?.evidence_id).eq('organization_id',orgId).eq('lead_id',lead.id).maybeSingle();
    if(doc.error)return new Response(JSON.stringify({error:'Could not validate company source document'}),{status:500,headers:H});
    let reference:any=null;try{reference=JSON.parse(doc.data?.raw_reference||'')}catch{}
    if(!doc.data||doc.data.verification_status!=='VERIFIED'||!doc.data.source_registry_id||doc.data.document_type!=='CNPJ_REGISTRY'||cnpjNorm(reference?.full_cnpj)!==cnpj)return new Response(JSON.stringify({error:'Verified scoped company registry document required'}),{status:409,headers:H});
    // Enrichment only observes the selected CNPJ. The final RPC owns every identity/review mutation.
    let enrichment:any=null;
    try{const resp=await fetch(url+'/functions/v1/cnpj-enrich',{method:'POST',headers:{Authorization:auth,'Content-Type':'application/json'},body:JSON.stringify({lead_id:lead.id,cnpj}),signal:AbortSignal.timeout(90000)});enrichment=await resp.json();if(!resp.ok)return new Response(JSON.stringify({error:'Company registry enrichment failed; confirmation was not applied'}),{status:502,headers:H})}catch{return new Response(JSON.stringify({error:'Company registry enrichment unavailable; confirmation was not applied'}),{status:502,headers:H})}
    if(!enrichment?.company_id||!enrichment?.evidence_id||enrichment.status==='REVIEW_REQUIRED')return new Response(JSON.stringify({error:'Company registry still requires source review; confirmation was not applied'}),{status:409,headers:H});
    const saved=await admin.rpc('review_company_name_candidate',{p_org:orgId,p_user:user.id,p_candidate:candidate.id,p_action:'CONFIRM',p_reason:null,p_company:enrichment.company_id,p_evidence:enrichment.evidence_id});
    if(saved.error||!saved.data)return new Response(JSON.stringify({error:'Confirmation blocked by a changed review, document or legal identity context'}),{status:saved.error?reviewStatus(saved.error.code):500,headers:H});
    return new Response(JSON.stringify({ok:true,lead_id:lead.id,cnpj,company_id:enrichment.company_id,candidate:saved.data,note:'CNPJ da entidade jurídica confirmado explicitamente pelo usuário. A confirmação não atribui identidade de sócios, parentesco ou posição financeira.'}),{headers:H});
  }

  if(lead.kind!=='PERSON')return new Response(JSON.stringify({error:'QSA identity candidates require a person lead; use company-name discovery for a legal entity'}),{status:409,headers:H});
  const md=candidate.metadata||{};
  const partner=personNorm(md.partner_name);
  if(!partner||partner!==personNorm(lead.name)||cnpjNorm(md.basic_cnpj)!==cnpj.slice(0,8))return new Response(JSON.stringify({error:'Candidate no longer matches the person name or company context; repeat name discovery'}),{status:409,headers:H});
  if(!uuid(md.evidence_id))return new Response(JSON.stringify({error:'Discovery document is not linked to this legacy candidate. Repeat name discovery before confirming.',code:'DISCOVERY_REQUERY_REQUIRED'}),{status:409,headers:H});
  const document=await admin.from('evidence').select('id,organization_id,lead_id,verification_status,source_registry_id,document_type,source_url,raw_reference').eq('id',md.evidence_id).eq('organization_id',orgId).eq('lead_id',lead.id).maybeSingle();
  if(document.error)return new Response(JSON.stringify({error:'Could not validate discovery source document'}),{status:500,headers:H});
  const doc=document.data;
  if(!doc||doc.verification_status!=='VERIFIED'||!doc.source_registry_id||doc.document_type!=='RFB_QSA_NAME_DISCOVERY'||doc.source_url!=='https://baseempresarial.com.br/empresa/'+cnpj)return new Response(JSON.stringify({error:'Verified scoped QSA discovery document required'}),{status:409,headers:H});
  const source=await admin.from('source_registry').select('id,key').eq('id',doc.source_registry_id).eq('key','base_empresarial_rfb').maybeSingle();
  if(source.error)return new Response(JSON.stringify({error:'Could not validate discovery source registry'}),{status:500,headers:H});
  let reference:any=null;try{reference=JSON.parse(doc.raw_reference||'')}catch{}
  const legacyReference='partner_name='+md.partner_name+'; basic_cnpj='+md.basic_cnpj;
  const referenceMatches=reference?.schema_version===2&&cnpjNorm(reference.full_cnpj)===cnpj&&cnpjNorm(reference.basic_cnpj)===cnpj.slice(0,8)&&personNorm(reference.partner_name)===partner&&personNorm(reference.query_name)===partner&&personNorm(reference.company_name)===personNorm(md.company_name)
   ||doc.raw_reference===legacyReference;
  if(!source.data||!referenceMatches)return new Response(JSON.stringify({error:'Discovery citation does not bind the exact CNPJ and QSA name'}),{status:409,headers:H});
  let enrichment:any=null;
  try{const response=await fetch(url+'/functions/v1/cnpj-enrich',{method:'POST',headers:{Authorization:auth,'Content-Type':'application/json'},body:JSON.stringify({lead_id:lead.id,cnpj}),signal:AbortSignal.timeout(90000)});enrichment=await response.json();if(!response.ok)return new Response(JSON.stringify({error:'Company registry enrichment failed; confirmation was not applied'}),{status:502,headers:H})}catch{return new Response(JSON.stringify({error:'Company registry enrichment unavailable; confirmation was not applied'}),{status:502,headers:H})}
  if(!uuid(enrichment?.company_id)||!uuid(enrichment?.evidence_id)||enrichment.status==='REVIEW_REQUIRED'||enrichment.ok===false)return new Response(JSON.stringify({error:'Company registry requires source review; confirmation was not applied'}),{status:409,headers:H});
  const reviewed=await admin.rpc('review_qsa_name_candidate',{p_org:orgId,p_user:user.id,p_candidate:candidate.id,p_action:'CONFIRM',p_reason:null,p_company:enrichment.company_id,p_evidence:enrichment.evidence_id});
  if(reviewed.error||!reviewed.data||reviewed.data.ok===false)return new Response(JSON.stringify({error:'Confirmation blocked by a changed review, source document or identity context'}),{status:reviewed.error?reviewStatus(reviewed.error.code):500,headers:H});
  return new Response(JSON.stringify({ok:true,lead_id:lead.id,cnpj,company_id:enrichment.company_id,candidate:reviewed.data,note:'Vínculo entre esta pessoa e a empresa selecionada confirmado explicitamente pelo usuário. Outros nomes, empresas e parentesco permanecem sujeitos a validação.'}),{headers:H});
});
