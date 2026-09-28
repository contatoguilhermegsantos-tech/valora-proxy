
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const H={"Content-Type":"application/json","Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS"};
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
  if(!candidateId||action!=="REJECT")return new Response(JSON.stringify({error:"candidate_id and action=REJECT required"}),{status:400,headers:H});
  if(reason.length<5)return new Response(JSON.stringify({error:"A rejection reason with at least 5 characters is required"}),{status:400,headers:H});

  const {data:p}=await admin.from("profiles").select("active_organization_id").eq("id",user.id).maybeSingle();
  const orgId=p?.active_organization_id;
  if(!orgId)return new Response(JSON.stringify({error:"No active organization"}),{status:409,headers:H});
  const {data:m}=await admin.from("organization_members").select("role,status").eq("organization_id",orgId).eq("user_id",user.id).maybeSingle();
  if(m?.status!=="ACTIVE")return new Response(JSON.stringify({error:"No organization access"}),{status:403,headers:H});
  if(m.role==="VIEWER")return new Response(JSON.stringify({error:"Viewer is read-only"}),{status:403,headers:H});

  const {data:candidate}=await admin.from("candidate_entities").select("*").eq("id",candidateId).eq("organization_id",orgId).maybeSingle();
  if(!candidate)return new Response(JSON.stringify({error:"Candidate not found"}),{status:404,headers:H});
  if(candidate.candidate_type!=="RFB_QSA_NAME_MATCH")return new Response(JSON.stringify({error:"Unsupported candidate type"}),{status:400,headers:H});

  const {data:lead}=await admin.from("leads").select("*").eq("id",candidate.lead_id).eq("organization_id",orgId).maybeSingle();
  if(!lead)return new Response(JSON.stringify({error:"Lead not found"}),{status:404,headers:H});

  const md=candidate.metadata||{};
  const fullCnpj=cnpjNorm(md.full_cnpj);
  const wasUserConfirmed=candidate.validation_status==="CONFIRMED"||Boolean(md.confirmed_by_user);

  await admin.from("candidate_entities").update({
    validation_status:"REJECTED",confidence:"LOW",
    metadata:{...md,confirmed_by_user:false,rejected_by_user:true,rejected_at:new Date().toISOString(),rejection_reason:reason}
  }).eq("id",candidate.id);

  await admin.from("identity_assessments").insert({
    organization_id:orgId,lead_id:lead.id,candidate_entity_id:candidate.id,
    score:0,decision:"REJECTED",
    factors:{user_rejected:true,previous_status:candidate.validation_status,reason},
    engine_version:"identity-v1.1",
    explanation:"Candidato rejeitado explicitamente pelo usuário como homônimo/vínculo incorreto.",
    created_by:user.id
  });

  // Retract only the disputed lead-to-company attribution; retain source documents.
  const {data:company}=await admin.from("companies").select("id").eq("organization_id",orgId).eq("cnpj",fullCnpj).maybeSingle();
  if(company){
    const {error:linkError}=await admin.from("lead_company_links").update({status:"REJECTED"}).eq("organization_id",orgId).eq("lead_id",lead.id).eq("company_id",company.id);
    if(linkError)return new Response(JSON.stringify({error:linkError.message}),{status:500,headers:H});
    const {error:relError}=await admin.from("relationships").update({status:"REJECTED",reason:"Vínculo rejeitado pelo usuário: "+reason}).eq("organization_id",orgId).eq("lead_id",lead.id).eq("from_entity_type","LEAD").eq("from_entity_id",lead.id).eq("to_entity_type","COMPANY").eq("to_entity_id",company.id).eq("relationship_type","BUSINESS_LINK");
    if(relError)return new Response(JSON.stringify({error:relError.message}),{status:500,headers:H});
  }
  const {count:remainingConfirmed}=await admin.from("candidate_entities").select("id",{count:"exact",head:true}).eq("organization_id",orgId).eq("lead_id",lead.id).eq("validation_status","CONFIRMED");
  if(wasUserConfirmed&&!remainingConfirmed){
    const patch:any={identity_confirmed_by_user:false,identity_status:"CAUTION",updated_at:new Date().toISOString()};
    if(md.assigned_initial_cnpj===true && cnpjShape(fullCnpj) && cnpjNorm(lead.initial_cnpj)===fullCnpj)patch.initial_cnpj=null;
    await admin.from("leads").update(patch).eq("id",lead.id).eq("organization_id",orgId);
  }

  let recomputed:any=null;
  try{
    const rr=await fetch(url+"/functions/v1/identity-resolution",{
      method:"POST",headers:{Authorization:auth,"Content-Type":"application/json"},
      body:JSON.stringify({lead_id:lead.id,run_discovery:false,run_fallback:false})
    });
    const txt=await rr.text();try{recomputed=txt?JSON.parse(txt):null}catch{recomputed={error:"Invalid identity-resolution response"}}
  }catch(e){recomputed={error:String(e)}}

  return new Response(JSON.stringify({
    ok:true,candidate_id:candidate.id,lead_id:lead.id,rejected:true,recomputed,
    note:"A rejeição remove este candidato da resolução automática. Outros candidatos permanecem sujeitos a validação."
  }),{headers:H});
});

