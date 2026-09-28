
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const H={"Content-Type":"application/json","Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS"};
const norm=(v:any)=>String(v??"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toUpperCase().replace(/[^A-Z0-9 ]/g," ").replace(/\s+/g," ").trim();
const cnpjNorm=(v:any)=>String(v??"").toUpperCase().replace(/[^A-Z0-9]/g,"");
const cnpjShape=(v:any)=>/^[A-Z0-9]{12}[0-9]{2}$/.test(cnpjNorm(v));
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function hash(v:string){
  const d=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(v));
  return Array.from(new Uint8Array(d)).map(x=>x.toString(16).padStart(2,"0")).join("");
}
async function fetchJsonRetry(url:string,attempts=4){
  let last=0;
  for(let i=0;i<attempts;i++){
    const r=await fetch(url,{signal:AbortSignal.timeout(12000),headers:{Accept:"application/json","User-Agent":"MAX-Identity/1.0"}});
    last=r.status;
    const txt=await r.text();
    if(r.ok){let j:any={};try{j=JSON.parse(txt)}catch{};return {ok:true,status:r.status,json:j}}
    if(r.status!==429)return {ok:false,status:r.status,json:null};
    await sleep([350,800,1600,2600][i]||3000);
  }
  return {ok:false,status:last,json:null};
}

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
  const researchRunId=b.research_run_id?String(b.research_run_id):null;
  if(!leadId)return new Response(JSON.stringify({error:"lead_id required"}),{status:400,headers:H});

  const {data:p}=await admin.from("profiles").select("active_organization_id").eq("id",user.id).maybeSingle();
  const orgId=p?.active_organization_id;
  if(!orgId)return new Response(JSON.stringify({error:"No active organization"}),{status:409,headers:H});
  const {data:m}=await admin.from("organization_members").select("role,status").eq("organization_id",orgId).eq("user_id",user.id).maybeSingle();
  if(m?.status!=="ACTIVE")return new Response(JSON.stringify({error:"No organization access"}),{status:403,headers:H});
  if(m.role==="VIEWER")return new Response(JSON.stringify({error:"Viewer is read-only"}),{status:403,headers:H});
  const {data:lead}=await admin.from("leads").select("*").eq("id",leadId).eq("organization_id",orgId).maybeSingle();
  if(!lead)return new Response(JSON.stringify({error:"Lead not found"}),{status:404,headers:H});
  if(lead.kind!=="PERSON")return new Response(JSON.stringify({ok:true,groups:[],note:"Cross identity validation applies to PERSON leads."}),{headers:H});

  const {data:candidates}=await admin.from("candidate_entities").select("*")
    .eq("organization_id",orgId).eq("lead_id",leadId).eq("candidate_type","RFB_QSA_NAME_MATCH")
    .neq("validation_status","REJECTED");

  const usable=(candidates||[]).filter((c:any)=>cnpjShape(c.metadata?.full_cnpj)&&norm(c.metadata?.partner_name||lead.name)===norm(lead.name)).slice(0,12);
  if(usable.length<2)return new Response(JSON.stringify({ok:true,candidates_checked:usable.length,groups:[],note:"Need at least two active company candidates to cross-validate identity."}),{headers:H});

  const observations:any[]=[];
  for(const c of usable){
    const cnpj=cnpjNorm(c.metadata?.full_cnpj);
    const resp=await fetchJsonRetry("https://brasilapi.com.br/api/cnpj/v1/"+cnpj);
    if(!resp.ok){observations.push({candidate_id:c.id,cnpj,ok:false,http_status:resp.status});continue}
    const qsa=Array.isArray(resp.json?.qsa)?resp.json.qsa:[];
    const person=qsa.find((x:any)=>Number(x?.identificador_de_socio||0)===2&&norm(x?.nome_socio)===norm(lead.name));
    const masked=String(person?.cnpj_cpf_do_socio||"").trim();
    const usableMasked=masked&&masked!=="***000000**"&&/[0-9]{4,}/.test(masked);
    const fp=usableMasked?await hash(norm(lead.name)+"|"+masked):null;
    observations.push({
      candidate_id:c.id,cnpj,ok:true,fingerprint_hash:fp,
      age_group:String(person?.faixa_etaria||c.metadata?.age_group||"")||null,
      partner_role:String(person?.qualificacao_socio||c.metadata?.partner_role||"")||null,
      source_date:String(person?.data_entrada_sociedade||"")||null
    });
    await sleep(80);
  }

  const grouped=new Map<string,any[]>();
  for(const o of observations.filter(x=>x.fingerprint_hash)){
    const arr=grouped.get(o.fingerprint_hash)||[];arr.push(o);grouped.set(o.fingerprint_hash,arr);
  }

  const {data:source}=await admin.from("source_registry").select("id").eq("key","brasilapi_cnpj").maybeSingle();
  const groups:any[]=[];
  for(const [fp,members] of grouped){
    if(members.length<2)continue;
    const now=new Date().toISOString();
    const anchorConfirmed=usable.some((c:any)=>c.validation_status==="CONFIRMED"&&members.some((m:any)=>m.candidate_id===c.id));
    const groupId=fp.slice(0,16);
    const updated:any[]=[];

    for(const member of members){
      const c=usable.find((x:any)=>x.id===member.candidate_id);
      if(!c)continue;
      const md=c.metadata||{};
      const validation=c.validation_status==="CONFIRMED"?"CONFIRMED":"SUPPORTED";
      await admin.from("candidate_entities").update({
        validation_status:validation,confidence:"HIGH",
        metadata:{...md,cross_identity_validation:{
          matched:true,method:"MASKED_QSA_IDENTIFIER_HASH",fingerprint_hash:fp,
          group_id:groupId,group_size:members.length,anchor_confirmed:anchorConfirmed,validated_at:now
        }}
      }).eq("id",c.id);

      const dedupeKey="identity_cross_qsa:"+leadId+":"+c.id+":"+groupId;
      const evHash=await hash(dedupeKey);
      const {data:ev}=await admin.from("evidence").upsert({
        organization_id:orgId,lead_id:leadId,source_registry_id:source?.id||null,
        title:"Validação cruzada de identidade no QSA — "+String(c.label||md.company_name||"empresa"),
        source_label:"BrasilAPI CNPJ (origem: base pública RFB)",
        source_url:md.source_url||("https://brasilapi.com.br/api/cnpj/v1/"+member.cnpj),
        source_kind:"AGGREGATOR",document_type:"QSA_CROSS_IDENTITY_MATCH",
        publisher:"BrasilAPI / dados de origem RFB",retrieved_at:now,evidence_hash:evHash,dedupe_key:dedupeKey,
        reliability_weight:0.8,raw_reference:"candidate="+c.id+"; group="+groupId,
        excerpt:"O mesmo nome completo e o mesmo identificador fiscal parcialmente mascarado aparecem no QSA de "+members.length+" empresas candidatas. O identificador bruto não é armazenado pelo MAX. Este cruzamento sustenta que os vínculos provavelmente pertencem à mesma pessoa, mas não substitui confirmação humana.",
        verification_status:"VERIFIED",last_verified_at:now,usage_scope:"INTERNAL",created_by:user.id
      },{onConflict:"organization_id,dedupe_key"}).select("id").maybeSingle();

      await admin.from("identity_assessments").insert({
        organization_id:orgId,lead_id:leadId,candidate_entity_id:c.id,research_run_id:researchRunId,
        score:anchorConfirmed?95:88,decision:c.validation_status==="CONFIRMED"?"CONFIRMED":"SUPPORTED",
        factors:{exact_name:true,cross_qsa_masked_identifier_match:true,group_size:members.length,anchor_confirmed:anchorConfirmed,evidence_id:ev?.id||null},
        engine_version:"identity-cross-v1.0",
        explanation:anchorConfirmed
          ?"Vínculo cruzado com candidato já confirmado pelo usuário por identificador fiscal mascarado consistente em QSA."
          :"Múltiplos vínculos empresariais compartilham nome completo e identificador fiscal mascarado consistente em QSA; suporte forte, não confirmação humana.",
        created_by:user.id
      });

      updated.push({candidate_id:c.id,label:c.label,validation_status:validation,evidence_id:ev?.id||null});
    }
    groups.push({group_id:groupId,size:members.length,anchor_confirmed:anchorConfirmed,candidates:updated});
  }

  return new Response(JSON.stringify({
    ok:true,candidates_checked:usable.length,observations:observations.map(x=>({candidate_id:x.candidate_id,cnpj:x.cnpj,ok:x.ok,http_status:x.http_status||null,has_fingerprint:Boolean(x.fingerprint_hash)})),
    groups,
    caveat:"O MAX compara apenas um hash do identificador fiscal parcialmente mascarado e não armazena o valor bruto. Match cruzado sustenta identidade, mas não promove automaticamente o lead a VERIFIED."
  }),{headers:H});
});

