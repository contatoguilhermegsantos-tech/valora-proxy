import {persistSourceEvidence} from '../_shared/source-evidence.ts';
import {fetchSourceJson} from '../_shared/source-operations.ts';
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const H={"Content-Type":"application/json","Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS"};
const norm=(v:string)=>(v||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toUpperCase().replace(/[^A-Z0-9 ]/g," ").replace(/\s+/g," ").trim();
const cnpjNorm=(v:unknown)=>String(v??"").toUpperCase().replace(/[^A-Z0-9]/g,"");
const cnpjShape=(v:unknown)=>/^[A-Z0-9]{12}[0-9]{2}$/.test(cnpjNorm(v));
async function fetchJsonRetry(url:string){
  const r=await fetchSourceJson(url,v=>v&&typeof v==='object'&&'data' in v,{headers:{'User-Agent':'MAX-Intelligence/1.0'}});
  return {...r,json:r.data};
}

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
  const leadId=String(b.lead_id||"");
  const researchRunId=b.research_run_id?String(b.research_run_id):null;
  if(!leadId) return new Response(JSON.stringify({error:"lead_id required"}),{status:400,headers:H});

  const {data:p}=await admin.from("profiles").select("active_organization_id").eq("id",user.id).single();
  const orgId=p?.active_organization_id;
  if(!orgId) return new Response(JSON.stringify({error:"No active organization"}),{status:409,headers:H});
  const {data:membership}=await admin.from("organization_members").select("role,status").eq("organization_id",orgId).eq("user_id",user.id).maybeSingle();
  if(membership?.status!=="ACTIVE"||membership.role==="VIEWER")return new Response(JSON.stringify({error:"Operator access required"}),{status:403,headers:H});
  const {data:lead}=await admin.from("leads").select("*").eq("id",leadId).eq("organization_id",orgId).maybeSingle();
  if(!lead) return new Response(JSON.stringify({error:"Lead not found"}),{status:404,headers:H});

  const name=norm(String(b.name||lead.name||""));
  if(name.split(" ").filter(Boolean).length<2) return new Response(JSON.stringify({ok:true,candidates:[],note:"Nome insuficiente para busca societária segura."}),{headers:H});

  const {data:sourceRow}=await admin.from("source_registry").select("id").eq("key","base_empresarial_rfb").single();
  const started=Date.now();
  const partnerUrl="https://app.baseempresarial.com.br/api/v1/partners?filter%5Bpartner_name%5D="+encodeURIComponent(name);

  let partnerJson:any=null;
  try{
    const rr=await fetchJsonRetry(partnerUrl);
    if(!rr.ok){
      await admin.from("source_fetch_logs").insert({
        organization_id:orgId,source_registry_id:sourceRow?.id,endpoint_reference:"app.baseempresarial.com.br/api/v1/partners",
        success:false,http_status:rr.status,result_status:"UPSTREAM_ERROR",duration_ms:Date.now()-started,created_by:user.id
      });
      return new Response(JSON.stringify({error:"Name discovery source unavailable",status:rr.status}),{status:502,headers:H});
    }
    partnerJson=rr.json;
  }catch(e){
    return new Response(JSON.stringify({error:"Name discovery network error",detail:String(e)}),{status:502,headers:H});
  }

  const exactPartners=(Array.isArray(partnerJson?.data)?partnerJson.data:[])
    .filter((x:any)=>norm(String(x.partner_name||""))===name);
  const partners=exactPartners.slice(0,15);
  let incomplete=exactPartners.length>partners.length||Boolean(partnerJson?.links?.next)||Number(partnerJson?.meta?.total||0)>Number(partnerJson?.data?.length||0);
  const searchLineage={original:{name:String(b.name||lead.name||''),city:lead.city||null,state:lead.state||null},query_name:name,transformations:['NAME_NORMALIZATION'],geographic_filter_applied:false,coverage:'Resposta nominal do provedor, limitada a 15 registros; sem pesquisa por sobrenome ou identidade pessoal confirmada.'};

  const existingQ=await admin.from("candidate_entities").select("id,metadata,validation_status")
    .eq("organization_id",orgId).eq("lead_id",leadId).eq("candidate_type","RFB_QSA_NAME_MATCH");
  if(existingQ.error)return new Response(JSON.stringify({error:'Could not load candidate reviews'}),{status:500,headers:H});
  const existing=new Map((existingQ.data||[]).map((x:any)=>[String(x.metadata?.basic_cnpj||""),x]));

  const candidates:any[]=[];
  for(const partner of partners){
    if(Date.now()-started>45000){incomplete=true;break;}
    const basic=cnpjNorm(partner.basic_cnpj).slice(0,8);
    if(basic.length!==8)continue;
    let company:any=null;
    try{
      const cr=await fetchJsonRetry(`https://app.baseempresarial.com.br/api/v1/companies/${basic}`);
      if(cr.ok) company=cr.json?.data||null;
    }catch{}
    if(!company){incomplete=true;continue;}

    const est=(Array.isArray(company.establishments)?company.establishments:[]);
    const hq=est.find((e:any)=>String(e.main_branch_office?.code||"")==="1")||est[0]||{};
    const fullCnpj=cnpjNorm(hq.full_cnpj||hq.id);
    const city=String(hq.address?.city?.name||"");
    const state=String(hq.address?.state?.abbreviation||"");
    const exactName=norm(String(partner.partner_name||""))===name;
    const cityMatch=Boolean(lead.city && norm(city)===norm(String(lead.city)));
    const stateMatch=Boolean(lead.state && state.toUpperCase()===String(lead.state).toUpperCase());
    const localityMatch=lead.city?cityMatch:stateMatch;
    const confidence=exactName&&cityMatch?"HIGH":exactName&&stateMatch?"MEDIUM":exactName?"MEDIUM":"LOW";
    const role=String(partner.role||company.partners?.find((x:any)=>x.id===partner.id)?.role||"Sócio/administrador");
    const reason=`O nome "${partner.partner_name}" consta no quadro societário da raiz CNPJ ${basic}, vinculada a ${company.corporate_name}. Nome igual não confirma que é a mesma pessoa do lead; homônimos devem ser descartados por contexto.`;

    const metadata={
      source_key:"base_empresarial_rfb",basic_cnpj:basic,full_cnpj:fullCnpj||null,
      company_name:company.corporate_name||null,trade_name:hq.trade_name||null,
      registration_status:hq.registration_status?.name||null,registration_status_date:hq.registration_status_date||null,
      city:city||null,state:state||null,equity_capital:company.equity_capital??null,
      company_size:company.company_size?.name||null,
      partner_name:partner.partner_name||lead.name,partner_role:role,
      partnership_start_date:partner.partnership_start_date||null,
      age_group:partner.age_group?.name||null,
      exact_name_match:exactName,locality_match:localityMatch,city_match:cityMatch,state_match:stateMatch,
      source_url:`https://baseempresarial.com.br/empresa/${fullCnpj||basic}`,
      search_lineage:{...searchLineage,match_scope:cityMatch?'CITY':stateMatch?'STATE':'NATIONAL',city_constraint_matched:cityMatch,state_constraint_matched:stateMatch}
    };

    let candidateId:string|null=null;
    const ex=existing.get(basic);
    if(ex){
      candidateId=ex.id;
      const updated=await admin.from("candidate_entities").update({
        research_run_id:researchRunId||undefined,label:company.corporate_name||basic,
        candidate_reason:reason,confidence:ex.validation_status==="CONFIRMED"?"HIGH":confidence,metadata:{...(ex.metadata||{}),...metadata}
      }).eq("id",ex.id).eq('organization_id',orgId).eq('validation_status',ex.validation_status);
      if(updated.error)return new Response(JSON.stringify({error:'Candidate persistence failed'}),{status:500,headers:H});
    }else{
      const ins=await admin.from("candidate_entities").insert({
        organization_id:orgId,lead_id:leadId,research_run_id:researchRunId,
        entity_type:"COMPANY",label:company.corporate_name||basic,candidate_reason:reason,
        candidate_type:"RFB_QSA_NAME_MATCH",confidence,validation_status:"UNVALIDATED",
        metadata,created_by:user.id
      }).select("id").single();
      if(ins.error)return new Response(JSON.stringify({error:'Candidate persistence failed'}),{status:500,headers:H});
      candidateId=ins.data?.id||null;
    }

    const digest=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(
      ["base_empresarial",name,basic,partner.partner_name,partner.partnership_start_date].join("|")
    )))).map(x=>x.toString(16).padStart(2,"0")).join("");

    const excerpt=[
      `Nome no QSA: ${partner.partner_name}`,
      `empresa: ${company.corporate_name}`,
      fullCnpj?`CNPJ da matriz: ${fullCnpj}`:`raiz CNPJ: ${basic}`,
      role?`qualificação: ${role}`:null,
      partner.partnership_start_date?`entrada na sociedade: ${partner.partnership_start_date}`:null,
      hq.registration_status?.name?`situação da empresa: ${hq.registration_status.name}`:null,
      city||state?`local da matriz: ${city||"?"}/${state||"?"}`:null,
      partner.age_group?.name?`faixa etária no cadastro: ${partner.age_group.name}`:null
    ].filter(Boolean).join("; ")+". A coincidência nominal é uma pista de identidade, não confirmação de que o registro pertence ao lead pesquisado.";

    const dedupeKey=`base_empresarial:name:${leadId}:${digest}`;
    const persistedEvidence=await persistSourceEvidence(admin,{
        organization_id:orgId,lead_id:leadId,source_registry_id:sourceRow?.id,
        title:`Candidato societário por nome — ${company.corporate_name}`,
        source_label:"Base Empresarial — dados públicos do CNPJ/RFB",
        source_url:metadata.source_url,source_kind:"AGGREGATOR",
        document_type:"RFB_QSA_NAME_DISCOVERY",publisher:"Base Empresarial / dados públicos do CNPJ-RFB",
        source_date:null,retrieved_at:new Date().toISOString(),evidence_hash:digest,
        dedupe_key:dedupeKey,reliability_weight:0.75,
        raw_reference:`partner_name=${partner.partner_name}; basic_cnpj=${basic}`,
        excerpt,verification_status:"VERIFIED",last_verified_at:new Date().toISOString(),
        usage_scope:"INTERNAL",created_by:user.id
      });
    if(persistedEvidence.error||!persistedEvidence.data)return new Response(JSON.stringify({error:'Evidence persistence failed'}),{status:500,headers:H});
    const evidenceId=persistedEvidence.data.id;

    candidates.push({candidate_id:candidateId,evidence_id:evidenceId,evidence_status:persistedEvidence.data.verification_status,...metadata,confidence,validation_status:ex?.validation_status||"UNVALIDATED"});
  }

  await admin.from("source_fetch_logs").insert({
    organization_id:orgId,source_registry_id:sourceRow?.id,endpoint_reference:"app.baseempresarial.com.br/api/v1/partners?filter[partner_name]",
    success:!incomplete,http_status:200,result_status:incomplete?'PARTIAL':candidates.length?"CANDIDATES_FOUND":"NO_CANDIDATES",
    duration_ms:Date.now()-started,created_by:user.id
  });

  return new Response(JSON.stringify({
    ok:true,status:incomplete?'PARTIAL':'COMPLETED',complete:!incomplete,query_name:name,candidates_found:candidates.length,candidates,search_lineage:searchLineage,
    caveat:"Resultado por nome é candidato de identidade. Não confirma que o sócio encontrado é a mesma pessoa do lead sem validação contextual."
  }),{headers:H});
});
