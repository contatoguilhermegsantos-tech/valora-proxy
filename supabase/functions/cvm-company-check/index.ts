
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const H={"Content-Type":"application/json","Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, GET, OPTIONS"};
const cnpjNorm=(v:unknown)=>String(v??"").toUpperCase().replace(/[^A-Z0-9]/g,"");
const cnpjShape=(v:unknown)=>/^[A-Z0-9]{12}[0-9]{2}$/.test(cnpjNorm(v));

function parseCsvLine(line:string,sep=";"){
  const out:string[]=[]; let cur=""; let quoted=false;
  for(let i=0;i<line.length;i++){
    const ch=line[i];
    if(ch === '"'){
      if(quoted && line[i+1] === '"'){ cur+='"'; i++; }
      else quoted=!quoted;
    } else if(ch===sep && !quoted){ out.push(cur); cur=""; }
    else cur+=ch;
  }
  out.push(cur);
  return out;
}
function dateIso(v:string|undefined|null){
  const s=(v||"").trim();
  if(!s) return null;
  if(/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if(/^\d{2}\/\d{2}\/\d{4}$/.test(s)){const [d,m,y]=s.split("/");return `${y}-${m}-${d}`;}
  return null;
}

Deno.serve(async(req:Request)=>{
  if(req.method==="OPTIONS") return new Response("ok",{headers:H});
  if(req.method==="OPTIONS") return new Response("ok",{headers:H});
  if(req.method!=="POST") return new Response(JSON.stringify({error:"POST required"}),{status:405,headers:H});
  const auth=req.headers.get("Authorization");
  if(!auth) return new Response(JSON.stringify({error:"Unauthorized"}),{status:401,headers:H});

  const url=Deno.env.get("SUPABASE_URL")!;
  const anon=Deno.env.get("SUPABASE_ANON_KEY")!;
  const service=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const userClient=createClient(url,anon,{global:{headers:{Authorization:auth}}});
  const admin=createClient(url,service);
  const {data:{user}}=await userClient.auth.getUser();
  if(!user) return new Response(JSON.stringify({error:"Unauthorized"}),{status:401,headers:H});

  const body=await req.json().catch(()=>({}));
  const leadId=String(body.lead_id||"");
  const companyId=String(body.company_id||"");
  if(!leadId||!companyId) return new Response(JSON.stringify({error:"lead_id and company_id required"}),{status:400,headers:H});

  const {data:profile}=await admin.from("profiles").select("active_organization_id").eq("id",user.id).single();
  const orgId=profile?.active_organization_id;
  if(!orgId) return new Response(JSON.stringify({error:"No active organization"}),{status:409,headers:H});

  const {data:company}=await admin.from("companies").select("*").eq("id",companyId).eq("organization_id",orgId).maybeSingle();
  const {data:lead}=await admin.from("leads").select("id").eq("id",leadId).eq("organization_id",orgId).maybeSingle();
  if(!company||!lead) return new Response(JSON.stringify({error:"Lead or company not found"}),{status:404,headers:H});
  const cnpj=cnpjNorm(company.cnpj);
  if(!cnpjShape(cnpj)) return new Response(JSON.stringify({error:"Company has no valid numeric/alphanumeric CNPJ"}),{status:400,headers:H});

  const sourceUrl="https://dados.cvm.gov.br/dados/CIA_ABERTA/CAD/DADOS/cad_cia_aberta.csv";
  const {data:source}=await admin.from("source_registry").select("id").eq("key","cvm").single();
  const started=Date.now();

  let resp:Response;
  try{resp=await fetch(sourceUrl,{headers:{Accept:"text/csv,*/*"}})}
  catch(e){
    await admin.from("source_fetch_logs").insert({
      organization_id:orgId,source_registry_id:source?.id,endpoint_reference:sourceUrl,
      success:false,result_status:"NETWORK_ERROR",error_summary:String(e),duration_ms:Date.now()-started,created_by:user.id
    });
    return new Response(JSON.stringify({error:"CVM dataset unavailable"}),{status:502,headers:H});
  }
  if(!resp.ok){
    await admin.from("source_fetch_logs").insert({
      organization_id:orgId,source_registry_id:source?.id,endpoint_reference:sourceUrl,
      success:false,http_status:resp.status,result_status:"UPSTREAM_ERROR",duration_ms:Date.now()-started,created_by:user.id
    });
    return new Response(JSON.stringify({error:"CVM dataset returned error",status:resp.status}),{status:502,headers:H});
  }

  const buf=await resp.arrayBuffer();
  let text="";
  try{text=new TextDecoder("windows-1252").decode(buf)}catch{text=new TextDecoder().decode(buf)}
  const lines=text.split(/\r?\n/).filter(Boolean);
  if(!lines.length) return new Response(JSON.stringify({error:"CVM dataset empty"}),{status:502,headers:H});

  const headers=parseCsvLine(lines[0]).map(x=>x.trim());
  let row:any=null;
  for(let i=1;i<lines.length;i++){
    const vals=parseCsvLine(lines[i]);
    const obj:any={}; headers.forEach((h,j)=>obj[h]=vals[j]??"");
    if(cnpjNorm(obj.CNPJ_CIA||obj.CNPJ||obj.CNPJ_CIA_ABERTA)===cnpj){row=obj;break;}
  }

  await admin.from("source_fetch_logs").insert({
    organization_id:orgId,source_registry_id:source?.id,endpoint_reference:sourceUrl,
    success:true,http_status:200,result_status:row?"MATCH":"NO_MATCH",duration_ms:Date.now()-started,created_by:user.id
  });
  await admin.from("source_registry").update({last_checked_at:new Date().toISOString(),connection_status:"CONNECTED_LIMITED"}).eq("key","cvm");
  await admin.from("source_sync_state").upsert({
    source_key:"cvm",last_attempt_at:new Date().toISOString(),last_success_at:new Date().toISOString(),
    last_status:row?"MATCH":"NO_MATCH",last_error:null,records_indexed:row?1:0,updated_at:new Date().toISOString()
  },{onConflict:"source_key"});

  if(!row){
    return new Response(JSON.stringify({
      ok:true,found:false,
      note:"CNPJ não localizado no cadastro de companhias abertas consultado. Isso não prova ausência de outras relações com o mercado de capitais."
    }),{headers:H});
  }

  const status=String(row.SIT||row.SITUACAO||"").trim()||null;
  const regDate=dateIso(row.DT_REG||row.DATA_REGISTRO);
  const cancelDate=dateIso(row.DT_CANCEL||row.DATA_CANCELAMENTO);
  const denom=String(row.DENOM_SOCIAL||row.DENOMINACAO_SOCIAL||company.legal_name||cnpj).trim();
  const category=String(row.CATEG_REG||row.CATEGORIA_REGISTRO||"").trim()||null;
  const excerpt=`Companhia: ${denom}; situação CVM: ${status||"não informada"}; data de registro: ${regDate||"não informada"}; data de cancelamento: ${cancelDate||"não informada"}; categoria: ${category||"não informada"}.`;

  const {data:evidence}=await admin.from("evidence").upsert({
    organization_id:orgId,lead_id:leadId,company_id:companyId,source_registry_id:source?.id,
    title:`Cadastro CVM — ${denom}`,source_label:"Comissão de Valores Mobiliários (CVM)",
    source_url:sourceUrl,source_kind:"PRIMARY_OFFICIAL",document_type:"CVM_COMPANY_REGISTRY",
    publisher:"CVM",retrieved_at:new Date().toISOString(),dedupe_key:`${leadId}:cvm:cad_cia_aberta:${cnpj}`,
    reliability_weight:1,raw_reference:cnpj,excerpt,verification_status:"VERIFIED",
    last_verified_at:new Date().toISOString(),usage_scope:"INTERNAL",created_by:user.id
  },{onConflict:"organization_id,dedupe_key"}).select("id").single();

  const claimIds:string[]=[];
  for(const [type,predicate,value] of [
    ["CVM_REGISTRATION","cvm_registration_status",status],
    ["CVM_CATEGORY","cvm_registration_category",category]
  ] as any[]){
    if(!value||!evidence?.id) continue;
    let {data:claim}=await admin.from("claims").select("id").eq("organization_id",orgId).eq("lead_id",leadId)
      .eq("company_id",companyId).eq("claim_type",type).eq("value_text",value).maybeSingle();
    if(!claim){
      const ins=await admin.from("claims").insert({
        organization_id:orgId,lead_id:leadId,company_id:companyId,claim_type:type,subject_label:denom,
        predicate,value_text:value,classification:"FACT",confidence:"HIGH",status:"PENDING",generated_by:"CONNECTOR",
        explanation:"Registro encontrado em conjunto de dados oficial da CVM.",valid_from:regDate,valid_to:cancelDate,created_by:user.id
      }).select("id").single();
      claim=ins.data;
    }
    if(claim?.id){
      await admin.from("claim_evidence").upsert({organization_id:orgId,claim_id:claim.id,evidence_id:evidence.id,support_type:"SUPPORTS",strength:1},{onConflict:"claim_id,evidence_id"});
      await admin.from("claims").update({status:"VERIFIED"}).eq("id",claim.id).neq("status","CONTRADICTED");
      claimIds.push(claim.id);
    }
  }

  const eventIds:string[]=[];
  if(regDate&&evidence?.id){
    let {data:event}=await admin.from("events").select("id").eq("organization_id",orgId).eq("lead_id",leadId)
      .eq("company_id",companyId).eq("event_type","CVM_REGISTRATION").eq("event_date",regDate).maybeSingle();
    if(!event){
      const ins=await admin.from("events").insert({
        organization_id:orgId,lead_id:leadId,company_id:companyId,event_type:"CVM_REGISTRATION",event_date:regDate,
        title:"Registro na CVM",description:`${denom} · ${status||"situação não informada"}`,
        classification:"FACT",confidence:"HIGH",status:"PENDING",metadata:{category,status},created_by:user.id
      }).select("id").single();
      event=ins.data;
    }
    if(event?.id){
      await admin.from("event_evidence").upsert({organization_id:orgId,event_id:event.id,evidence_id:evidence.id,support_type:"SUPPORTS",strength:1},{onConflict:"event_id,evidence_id"});
      await admin.from("events").update({status:"VERIFIED"}).eq("id",event.id);
      eventIds.push(event.id);
    }
  }
  if(cancelDate&&evidence?.id){
    let {data:event}=await admin.from("events").select("id").eq("organization_id",orgId).eq("lead_id",leadId)
      .eq("company_id",companyId).eq("event_type","CVM_REGISTRATION_CANCELLED").eq("event_date",cancelDate).maybeSingle();
    if(!event){
      const ins=await admin.from("events").insert({
        organization_id:orgId,lead_id:leadId,company_id:companyId,event_type:"CVM_REGISTRATION_CANCELLED",event_date:cancelDate,
        title:"Cancelamento de registro na CVM",description:denom,classification:"FACT",confidence:"HIGH",status:"PENDING",
        metadata:{status},created_by:user.id
      }).select("id").single();
      event=ins.data;
    }
    if(event?.id){
      await admin.from("event_evidence").upsert({organization_id:orgId,event_id:event.id,evidence_id:evidence.id,support_type:"SUPPORTS",strength:1},{onConflict:"event_id,evidence_id"});
      await admin.from("events").update({status:"VERIFIED"}).eq("id",event.id);
      eventIds.push(event.id);
    }
  }

  return new Response(JSON.stringify({ok:true,found:true,evidence_id:evidence?.id,claim_ids:claimIds,event_ids:eventIds,data:{denom,status,regDate,cancelDate,category}}),{headers:H});
});


