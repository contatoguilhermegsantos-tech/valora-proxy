
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const H={"Content-Type":"application/json","Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS"};
const uuid=(v:unknown)=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const reviewStatus=(code:unknown)=>({42501:403,P0002:404,22023:400,P0001:409} as Record<string,number>)[String(code)]||500;
const cnpjNorm=(v:unknown)=>String(v??"").toUpperCase().replace(/[^A-Z0-9]/g,"");
const cnpjShape=(v:unknown)=>/^[A-Z0-9]{12}[0-9]{2}$/.test(cnpjNorm(v));

Deno.serve(async(req:Request)=>{
  if(req.method==="OPTIONS")return new Response("ok",{headers:H});
  if(req.method!=="POST")return new Response(JSON.stringify({error:"POST required"}),{status:405,headers:H});
  const auth=req.headers.get("Authorization")||"";
  if(!auth)return new Response(JSON.stringify({error:"Unauthorized"}),{status:401,headers:H});

  const url=Deno.env.get("SUPABASE_URL")!,anon=Deno.env.get("SUPABASE_ANON_KEY")!,service=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const uc=createClient(url,anon,{global:{headers:{Authorization:auth}}});
  const admin=createClient(url,service);
  const {data:{user}}=await uc.auth.getUser();
  if(!user)return new Response(JSON.stringify({error:"Unauthorized"}),{status:401,headers:H});

  const b=await req.json().catch(()=>({}));
  const candidateId=String(b.candidate_id||"");
  const action=String(b.action||"REJECT").toUpperCase();
  const reason=String(b.reason||"").trim();
  if(!uuid(candidateId)||action!=="REJECT")return new Response(JSON.stringify({error:"Valid candidate_id and action=REJECT required"}),{status:400,headers:H});
  if(reason.length<5||reason.length>1000)return new Response(JSON.stringify({error:"A rejection reason with 5 to 1000 characters is required"}),{status:400,headers:H});

  const {data:p,error:profileError}=await admin.from("profiles").select("active_organization_id").eq("id",user.id).maybeSingle();
  if(profileError)return new Response(JSON.stringify({error:'Could not validate active organization'}),{status:500,headers:H});
  const orgId=p?.active_organization_id;
  if(!orgId)return new Response(JSON.stringify({error:"No active organization"}),{status:409,headers:H});
  const {data:m,error:membershipError}=await admin.from("organization_members").select("role,status").eq("organization_id",orgId).eq("user_id",user.id).maybeSingle();
  if(membershipError)return new Response(JSON.stringify({error:'Could not validate operator membership'}),{status:500,headers:H});
  if(m?.status!=="ACTIVE")return new Response(JSON.stringify({error:"No organization access"}),{status:403,headers:H});
  if(!['OWNER','ADMIN','ANALYST','MEMBER'].includes(m.role))return new Response(JSON.stringify({error:"Operator access required"}),{status:403,headers:H});

  const {data:candidate,error:candidateError}=await admin.from("candidate_entities").select("*").eq("id",candidateId).eq("organization_id",orgId).maybeSingle();
  if(candidateError)return new Response(JSON.stringify({error:'Could not validate candidate review'}),{status:500,headers:H});
  if(!candidate)return new Response(JSON.stringify({error:"Candidate not found"}),{status:404,headers:H});
  if(!['RFB_QSA_NAME_MATCH','RFB_COMPANY_NAME_MATCH'].includes(candidate.candidate_type))return new Response(JSON.stringify({error:"Unsupported candidate type"}),{status:400,headers:H});
  if(candidate.candidate_type==='RFB_COMPANY_NAME_MATCH'){
    if(candidate.entity_type!=='COMPANY')return new Response(JSON.stringify({error:'Company registry candidate required'}),{status:409,headers:H});
    const reviewed=await admin.rpc('review_company_name_candidate',{p_org:orgId,p_user:user.id,p_candidate:candidate.id,p_action:'REJECT',p_reason:reason,p_company:null,p_evidence:null});
    if(reviewed.error||!reviewed.data)return new Response(JSON.stringify({error:'Rejection blocked by a changed review or confirmed legal identity; use the identity review workflow'}),{status:reviewed.error?reviewStatus(reviewed.error.code):500,headers:H});
    return new Response(JSON.stringify({ok:true,candidate_id:candidate.id,lead_id:candidate.lead_id,rejected:true,candidate:reviewed.data,recomputed:null,note:'Candidato empresarial descartado. Documentos, CNPJs confirmados e outros vínculos permanecem preservados.'}),{headers:H});
  }

  const lead=await admin.from('leads').select('id,kind').eq('id',candidate.lead_id).eq('organization_id',orgId).maybeSingle();
  if(lead.error)return new Response(JSON.stringify({error:'Could not validate candidate lead'}),{status:500,headers:H});
  if(!lead.data)return new Response(JSON.stringify({error:'Lead not found'}),{status:404,headers:H});
  if(candidate.entity_type!=='COMPANY'||lead.data.kind!=='PERSON')return new Response(JSON.stringify({error:'QSA identity candidates require a person lead'}),{status:409,headers:H});
  const reviewed=await admin.rpc('review_qsa_name_candidate',{p_org:orgId,p_user:user.id,p_candidate:candidate.id,p_action:'REJECT',p_reason:reason,p_company:null,p_evidence:null});
  if(reviewed.error||!reviewed.data||reviewed.data.ok===false)return new Response(JSON.stringify({error:'Rejection could not be committed; the previous review was preserved'}),{status:reviewed.error?reviewStatus(reviewed.error.code):500,headers:H});
  let recomputed:any=null;let recomputeStatus='COMPLETED';
  try{const response=await fetch(url+'/functions/v1/identity-resolution',{method:'POST',headers:{Authorization:auth,'Content-Type':'application/json'},body:JSON.stringify({lead_id:lead.data.id,run_discovery:false,run_fallback:false}),signal:AbortSignal.timeout(25000)});const data=await response.json();if(!response.ok||data?.ok!==true){recomputeStatus='PENDING_RETRY'}else recomputed=data}catch{recomputeStatus='PENDING_RETRY'}
  return new Response(JSON.stringify({ok:true,candidate_id:candidate.id,lead_id:lead.data.id,rejected:true,candidate:reviewed.data,recomputed,recompute_status:recomputeStatus,note:recomputeStatus==='COMPLETED'?'Candidato descartado com auditoria. Outros vínculos confirmados e documentos foram preservados.':'Candidato descartado com auditoria. O recálculo complementar ficou pendente; a revisão e os demais vínculos foram preservados.'}),{headers:H});
});
