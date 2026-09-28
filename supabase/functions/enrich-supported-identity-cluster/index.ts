
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const H={"Content-Type":"application/json","Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS"};
const cnpjNorm=(v:any)=>String(v??"").toUpperCase().replace(/[^A-Z0-9]/g,"");
const cnpjShape=(v:any)=>/^[A-Z0-9]{12}[0-9]{2}$/.test(cnpjNorm(v));

Deno.serve(async(req:Request)=>{
  if(req.method==="OPTIONS")return new Response("ok",{headers:H});
  if(req.method!=="POST")return new Response(JSON.stringify({error:"POST required"}),{status:405,headers:H});
  const auth=req.headers.get("Authorization")||"";
  if(!auth)return new Response(JSON.stringify({error:"Unauthorized"}),{status:401,headers:H});

  const url=Deno.env.get("SUPABASE_URL")!,anon=Deno.env.get("SUPABASE_ANON_KEY")!,service=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const uc=createClient(url,anon,{global:{headers:{Authorization:auth}}}),admin=createClient(url,service);
  const {data:{user}}=await uc.auth.getUser();
  if(!user)return new Response(JSON.stringify({error:"Unauthorized"}),{status:401,headers:H});

  const b=await req.json().catch(()=>({}));
  const leadId=String(b.lead_id||"");
  if(!leadId)return new Response(JSON.stringify({error:"lead_id required"}),{status:400,headers:H});

  const {data:p}=await admin.from("profiles").select("active_organization_id").eq("id",user.id).maybeSingle();
  const orgId=p?.active_organization_id;
  if(!orgId)return new Response(JSON.stringify({error:"No active organization"}),{status:409,headers:H});
  const {data:m}=await admin.from("organization_members").select("role,status").eq("organization_id",orgId).eq("user_id",user.id).maybeSingle();
  if(m?.status!=="ACTIVE")return new Response(JSON.stringify({error:"No organization access"}),{status:403,headers:H});
  if(m.role==="VIEWER")return new Response(JSON.stringify({error:"Viewer is read-only"}),{status:403,headers:H});
  const {data:lead}=await admin.from("leads").select("id,name,kind,identity_status").eq("id",leadId).eq("organization_id",orgId).maybeSingle();
  if(!lead)return new Response(JSON.stringify({error:"Lead not found"}),{status:404,headers:H});
  if(lead.kind!=="PERSON")return new Response(JSON.stringify({ok:true,companies:[],note:"Cluster enrichment applies to PERSON leads."}),{headers:H});

  const {data:candidates}=await admin.from("candidate_entities").select("*")
    .eq("organization_id",orgId).eq("lead_id",leadId).eq("candidate_type","RFB_QSA_NAME_MATCH")
    .in("validation_status",["SUPPORTED","CONFIRMED"]);

  const eligible=(candidates||[]).filter((c:any)=>{
    const md=c.metadata||{};
    const score=Number(md.identity_engine?.score||0);
    const cross=Boolean(md.cross_identity_validation?.matched);
    return cnpjShape(md.full_cnpj) && (c.validation_status==="CONFIRMED" || (!md.identity_engine?.ambiguous && md.identity_engine?.decision==="SUPPORTED" && (score>=75 || cross)));
  }).slice(0,8);

  const companies:any[]=[];
  const errors:any[]=[];

  for(const candidate of eligible){
    const md=candidate.metadata||{};
    const cnpj=cnpjNorm(md.full_cnpj);
    try{
      const resp=await fetch(url+"/functions/v1/cnpj-enrich",{
        method:"POST",headers:{Authorization:auth,"Content-Type":"application/json"},
        body:JSON.stringify({lead_id:leadId,cnpj})
      });
      const txt=await resp.text();let data:any=null;try{data=txt?JSON.parse(txt):null}catch{data={error:"Invalid CNPJ enrichment response"}}
      if(!resp.ok||!data?.company_id){
        errors.push({candidate_id:candidate.id,cnpj,error:data?.error||("HTTP "+resp.status)});
        continue;
      }

      const targetStatus=candidate.validation_status==="CONFIRMED"?"VERIFIED":"SUPPORTED";
      const role=String(md.partner_role||"Vínculo empresarial suportado");
      const {data:link}=await admin.from("lead_company_links").select("id,status").eq("organization_id",orgId)
        .eq("lead_id",leadId).eq("company_id",data.company_id).maybeSingle();
      if(link && !["VERIFIED","CONFIRMED"].includes(link.status)){
        await admin.from("lead_company_links").update({
          status:targetStatus,
          role_label:targetStatus==="VERIFIED"?role:("Suportado por resolução de identidade · "+role)
        }).eq("id",link.id);
      }

      const {data:existingRel}=await admin.from("relationships").select("id,status,classification")
        .eq("organization_id",orgId).eq("lead_id",leadId)
        .eq("from_entity_type","LEAD").eq("from_entity_id",leadId)
        .eq("to_entity_type","COMPANY").eq("to_entity_id",data.company_id)
        .eq("relationship_type","BUSINESS_LINK").maybeSingle();

      let relId=existingRel?.id||null;
      const confirmed=targetStatus==="VERIFIED";
      const reason=confirmed
        ?"Vínculo empresarial confirmado explicitamente pelo usuário e sustentado por cadastro/QSA consultado."
        :"Vínculo empresarial suportado por nome completo, contexto territorial e/ou validação cruzada do QSA. Ainda não equivale a confirmação humana.";

      if(!relId){
        const ins=await admin.from("relationships").insert({
          organization_id:orgId,lead_id:leadId,
          from_entity_type:"LEAD",from_entity_id:leadId,from_label:lead.name,
          to_entity_type:"COMPANY",to_entity_id:data.company_id,to_label:md.company_name||candidate.label,
          relationship_type:"BUSINESS_LINK",
          classification:confirmed?"FACT":"INDICATION",
          confidence:"HIGH",status:"PENDING",reason,created_by:user.id
        }).select("id").single();
        relId=ins.data?.id||null;
      }else if(existingRel?.status!=="VERIFIED"){
        await admin.from("relationships").update({
          classification:confirmed?"FACT":"INDICATION",confidence:"HIGH",reason
        }).eq("id",relId);
      }

      if(relId&&data.evidence_id){
        await admin.from("relationship_evidence").upsert({
          organization_id:orgId,relationship_id:relId,evidence_id:data.evidence_id,
          support_type:"SUPPORTS",strength:confirmed?1:0.8
        },{onConflict:"relationship_id,evidence_id"});
        if(confirmed){
          await admin.from("relationships").update({status:"VERIFIED",classification:"FACT",confidence:"HIGH"}).eq("id",relId);
        }
      }

      let companyResearchJob:any=null;
      const {data:lastJob}=await admin.from("research_job_queue").select("id,status,created_at")
        .eq("organization_id",orgId).eq("lead_id",leadId).eq("company_id",data.company_id)
        .eq("job_type","COMPANY_RESEARCH").order("created_at",{ascending:false}).limit(1).maybeSingle();
      const recentCompleted=lastJob?.status==="COMPLETED" && (Date.now()-new Date(lastJob.created_at).getTime())<24*60*60*1000;
      if(lastJob&&(["PENDING","RUNNING","RETRY"].includes(lastJob.status)||recentCompleted)){
        companyResearchJob=lastJob;
      }else{
        const {data:newJob,error:jobErr}=await admin.from("research_job_queue").insert({
          organization_id:orgId,lead_id:leadId,company_id:data.company_id,requested_by:user.id,
          job_type:"COMPANY_RESEARCH",strategy:"EMPRESARIO",
          payload:{objective:"Pesquisa profunda automática do núcleo empresarial suportado",source_candidate_id:candidate.id},
          status:"PENDING",priority:120,
          progress:{stage:"QUEUED",message:"Pesquisa profunda da empresa aguardando processamento."}
        }).select("id,status,created_at").single();
        if(!jobErr)companyResearchJob=newJob;
        else errors.push({candidate_id:candidate.id,cnpj,error:"Could not queue company research: "+jobErr.message});
      }

      companies.push({
        candidate_id:candidate.id,company_id:data.company_id,cnpj,
        company_name:md.company_name||candidate.label,
        validation_status:candidate.validation_status,link_status:targetStatus,
        relationship_id:relId,evidence_id:data.evidence_id||null,
        company_research_job_id:companyResearchJob?.id||null,
        company_research_job_status:companyResearchJob?.status||null
      });
    }catch(e){
      errors.push({candidate_id:candidate.id,cnpj,error:String(e)});
    }
  }

  return new Response(JSON.stringify({
    ok:errors.length===0||companies.length>0,
    eligible_candidates:eligible.length,enriched_companies:companies.length,companies,errors,
    caveat:"Empresas SUPPORTED entram como vínculos indicativos no ecossistema; apenas vínculos confirmados pelo usuário são tratados como FACT/VERIFIED."
  }),{status:errors.length&&companies.length===0?502:200,headers:H});
});

