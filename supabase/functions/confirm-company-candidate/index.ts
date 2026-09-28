
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const H={"Content-Type":"application/json","Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS"};
const cnpjNorm=(v:unknown)=>String(v??"").toUpperCase().replace(/[^A-Z0-9]/g,"");
const isValidCnpj=(v:unknown)=>{const c=cnpjNorm(v);if(!/^[A-Z0-9]{12}[0-9]{2}$/.test(c))return false;const val=(x:string)=>x.charCodeAt(0)-48;const calc=(base:string,w:number[])=>{const sum=[...base].reduce((a,ch,i)=>a+val(ch)*w[i],0),r=sum%11;return r<2?0:11-r};const d1=calc(c.slice(0,12),[5,4,3,2,9,8,7,6,5,4,3,2]);return d1===Number(c[12])&&calc(c.slice(0,12)+String(d1),[6,5,4,3,2,9,8,7,6,5,4,3,2])===Number(c[13])};

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
  if(!candidateId) return new Response(JSON.stringify({error:"candidate_id required"}),{status:400,headers:H});

  const {data:p}=await admin.from("profiles").select("active_organization_id").eq("id",user.id).single();
  const orgId=p?.active_organization_id;
  if(!orgId) return new Response(JSON.stringify({error:"No active organization"}),{status:409,headers:H});
  const {data:membership}=await admin.from("organization_members").select("role,status").eq("organization_id",orgId).eq("user_id",user.id).maybeSingle();
  if(membership?.status!=="ACTIVE"||membership.role==="VIEWER")return new Response(JSON.stringify({error:"Operator access required"}),{status:403,headers:H});
  const {data:candidate}=await admin.from("candidate_entities").select("*")
    .eq("id",candidateId).eq("organization_id",orgId).maybeSingle();
  if(!candidate) return new Response(JSON.stringify({error:"Candidate not found"}),{status:404,headers:H});
  if(candidate.entity_type!=="COMPANY"||candidate.candidate_type!=="RFB_QSA_NAME_MATCH") return new Response(JSON.stringify({error:"Unsupported candidate type"}),{status:400,headers:H});

  const cnpj=cnpjNorm(candidate.metadata?.full_cnpj);
  if(!isValidCnpj(cnpj)) return new Response(JSON.stringify({error:"Candidate has no valid numeric/alphanumeric CNPJ"}),{status:400,headers:H});

  const {data:lead}=await admin.from("leads").select("id,initial_cnpj").eq("id",candidate.lead_id).eq("organization_id",orgId).maybeSingle();
  if(!lead) return new Response(JSON.stringify({error:"Lead not found"}),{status:404,headers:H});

  // User explicitly confirms this candidate as relevant to the lead.
  await admin.from("candidate_entities").update({
    validation_status:"CONFIRMED",confidence:"HIGH",
    metadata:{...(candidate.metadata||{}),confirmed_by_user:true,confirmed_at:new Date().toISOString(),assigned_initial_cnpj:!lead.initial_cnpj}
  }).eq("id",candidateId);

  if(!lead.initial_cnpj) await admin.from("leads").update({initial_cnpj:cnpj}).eq("id",lead.id);

  // Reuse the canonical CNPJ enrichment connector so company/QSA/evidence are persisted consistently.
  const resp=await fetch(url+"/functions/v1/cnpj-enrich",{
    method:"POST",headers:{Authorization:auth,"Content-Type":"application/json"},
    body:JSON.stringify({lead_id:lead.id,cnpj})
  });
  const text=await resp.text();
  let data:any=null;try{data=text?JSON.parse(text):null}catch{data={raw:text}}
  if(!resp.ok) return new Response(JSON.stringify({error:"Candidate confirmed, but CNPJ enrichment failed",cnpj,detail:data}),{status:502,headers:H});

  // Upgrade the lead-company link because the user explicitly selected the candidate.
  if(data?.company_id){
    const {error:linkError}=await admin.from("lead_company_links").update({
      role_label:String(candidate.metadata?.partner_role||"Vínculo societário confirmado pelo usuário"),
      status:"VERIFIED"
    }).eq("organization_id",orgId).eq("lead_id",lead.id).eq("company_id",data.company_id);
    if(linkError)return new Response(JSON.stringify({error:linkError.message}),{status:500,headers:H});
  }

  await admin.from("leads").update({identity_status:"VERIFIED",identity_confirmed_by_user:true,updated_at:new Date().toISOString()}).eq("id",lead.id).eq("organization_id",orgId);

  await admin.from("identity_assessments").insert({
    organization_id:orgId,lead_id:lead.id,candidate_entity_id:candidate.id,
    score:100,decision:"CONFIRMED",
    factors:{user_confirmed:true,confirmed_company_cnpj:cnpj},
    engine_version:"identity-v1.0",
    explanation:"Vínculo candidato confirmado explicitamente pelo usuário; confirmação limitada ao vínculo selecionado.",
    created_by:user.id
  });

  return new Response(JSON.stringify({
    ok:true,lead_id:lead.id,cnpj,company_id:data?.company_id||null,
    note:"Candidato confirmado pelo usuário e enriquecido pelo conector de CNPJ. A confirmação vale para o vínculo selecionado; demais inferências continuam dependentes de evidência."
  }),{headers:H});
});

