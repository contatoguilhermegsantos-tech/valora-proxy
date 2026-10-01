import {sourceBatches} from '../_shared/source-batches.ts';

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const H={
  "Content-Type":"application/json",
  "Access-Control-Allow-Origin":"*",
  "Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods":"POST, OPTIONS"
};
const API="https://centraldebalancos.estaleiro.serpro.gov.br/centralbalancos/servicesapi/api";
const cnpjNorm=(v:unknown)=>String(v??"").toUpperCase().replace(/[^A-Z0-9]/g,"");
const cnpjShape=(v:unknown)=>/^[A-Z0-9]{12}[0-9]{2}$/.test(cnpjNorm(v));
const safeDate=(v:unknown)=>{
  const s=String(v??"").trim();
  if(!s||s.startsWith("0001-01-01")) return null;
  const d=new Date(s);
  return Number.isNaN(d.getTime())?null:s.slice(0,10);
};
const eventType=(doc:any)=>{
  const s=[doc?.tipoDemonstracao,doc?.titulo,doc?.descricao,doc?.categoria].filter(Boolean).join(" ").toLowerCase();
  if(/assembleia|acionista|ata|conselho|convoca/.test(s)) return "CORPORATE_GOVERNANCE_FILING";
  if(/balanço|balanco|demonstra|dre|dfc|dmpl|dlpa|notas explicativas|auditor/.test(s)) return "FINANCIAL_STATEMENT_PUBLICATION";
  return "SPED_DOCUMENT_PUBLICATION";
};
async function sha256(v:string){
  const b=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(v));
  return [...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,"0")).join("");
}
async function getJson(url:string){
  let last="";
  for(let attempt=0;attempt<3;attempt++){
    try{
      const r=await fetch(url,{headers:{Accept:"application/json","User-Agent":"MAX-Intelligence/1.0"}});
      const text=await r.text();
      if(r.ok&&text.trim()){
        try{return {ok:true,status:r.status,data:JSON.parse(text),error:null}}
        catch(e){last="Invalid JSON: "+String(e)}
      }else last="HTTP "+r.status+(text?" — "+text.slice(0,180):"");
    }catch(e){last=String(e)}
    if(attempt<2) await new Promise(res=>setTimeout(res,400*Math.pow(2,attempt)));
  }
  return {ok:false,status:502,data:null,error:last||"Central de Balanços unavailable"};
}

Deno.serve(async(req:Request)=>{
  if(req.method==="OPTIONS") return new Response("ok",{headers:H});
  if(req.method!=="POST") return new Response(JSON.stringify({error:"POST required"}),{status:405,headers:H});

  const auth=req.headers.get("Authorization")||"";
  if(!auth) return new Response(JSON.stringify({error:"Unauthorized"}),{status:401,headers:H});

  const base=Deno.env.get("SUPABASE_URL")!;
  const anon=Deno.env.get("SUPABASE_ANON_KEY")!;
  const service=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const uc=createClient(base,anon,{global:{headers:{Authorization:auth}}});
  const admin=createClient(base,service);
  const {data:{user}}=await uc.auth.getUser();
  if(!user) return new Response(JSON.stringify({error:"Unauthorized"}),{status:401,headers:H});

  const b=await req.json().catch(()=>({}));
  const leadId=String(b.lead_id||"");
  const companyId=String(b.company_id||"");
  if(!leadId||!companyId) return new Response(JSON.stringify({error:"lead_id and company_id required"}),{status:400,headers:H});

  const {data:p}=await admin.from("profiles").select("active_organization_id").eq("id",user.id).maybeSingle();
  const orgId=p?.active_organization_id;
  if(!orgId) return new Response(JSON.stringify({error:"No active organization"}),{status:409,headers:H});

  const {data:m}=await admin.from("organization_members").select("status,role").eq("organization_id",orgId).eq("user_id",user.id).maybeSingle();
  if(m?.status!=="ACTIVE"||m.role==='VIEWER') return new Response(JSON.stringify({error:"No organization access"}),{status:403,headers:H});

  const [{data:lead},{data:company},{data:source}]=await Promise.all([
    admin.from("leads").select("id,name").eq("id",leadId).eq("organization_id",orgId).maybeSingle(),
    admin.from("companies").select("id,cnpj,legal_name,trade_name").eq("id",companyId).eq("organization_id",orgId).maybeSingle(),
    admin.from("source_registry").select("id").eq("key","central_balancos_sped").maybeSingle()
  ]);
  if(!lead||!company) return new Response(JSON.stringify({error:"Lead or company not found"}),{status:404,headers:H});
  const {data:companyLink,error:linkError}=await admin.from('lead_company_links').select('status').eq('organization_id',orgId).eq('lead_id',leadId).eq('company_id',companyId).maybeSingle();
  if(linkError)return new Response(JSON.stringify({error:'Could not validate company context'}),{status:500,headers:H});
  if(!companyLink||!['SUPPORTED','VERIFIED'].includes(companyLink.status))return new Response(JSON.stringify({error:'Company attribution requires validation in this lead'}),{status:409,headers:H});
  const cnpj=cnpjNorm(company.cnpj);
  if(!cnpjShape(cnpj)) return new Response(JSON.stringify({error:"Company has no valid numeric/alphanumeric CNPJ"}),{status:400,headers:H});

  const started=Date.now();
  const participantRes=await getJson(API+"/Participante/"+cnpj);
  if(!participantRes.ok){
    await admin.from("source_fetch_logs").insert({
      organization_id:orgId,research_run_id:b.research_run_id||null,source_registry_id:source?.id,
      endpoint_reference:"Central de Balanços /Participante/{CNPJ}",result_status:"FAILED",
      http_status:participantRes.status,success:false,duration_ms:Date.now()-started,error_summary:participantRes.error,created_by:user.id
    });
    return new Response(JSON.stringify({error:"Central de Balanços unavailable",detail:participantRes.error}),{status:502,headers:H});
  }

  const participantItems=Array.isArray(participantRes.data?.items)?participantRes.data.items:[];
  const participant=participantItems.length===1?participantItems[0]:participantItems.find((x:any)=>cnpjNorm(x?.cnpj)===cnpj)||null;
  if(!participant?.id){
    const now=new Date().toISOString();
    await Promise.all([
      admin.from("source_fetch_logs").insert({
        organization_id:orgId,research_run_id:b.research_run_id||null,source_registry_id:source?.id,
        endpoint_reference:"Central de Balanços /Participante/{CNPJ}",result_status:"NO_MATCH",
        http_status:participantRes.status,success:true,duration_ms:Date.now()-started,error_summary:null,created_by:user.id
      }),
      admin.from("source_registry").update({
        connection_status:"CONNECTED",last_checked_at:now,
        limitations:"Fonte pública oficial do SPED. Participação/publicação depende do universo coberto pela Central; ausência de documento não prova ausência de demonstrações, lucro, dividendos, patrimônio ou ato societário."
      }).eq("key","central_balancos_sped")
    ]);
    return new Response(JSON.stringify({ok:true,participant_found:false,documents_found:0,persisted:0}),{headers:H});
  }

  const pageSize=100,maxPages=5;
  const docs:any[]=[];
  let totalCount=0;
  for(let page=1;page<=maxPages;page++){
    const u=API+"/Demonstracao/"+encodeURIComponent(String(participant.id))+"/0/0?page="+page+"&pageSize="+pageSize;
    const dr=await getJson(u);
    if(!dr.ok){
      await admin.from("source_fetch_logs").insert({
        organization_id:orgId,research_run_id:b.research_run_id||null,source_registry_id:source?.id,
        endpoint_reference:"Central de Balanços /Demonstracao/{participante}/0/0",result_status:docs.length?"PARTIAL":"FAILED",
        http_status:dr.status,success:false,duration_ms:Date.now()-started,error_summary:dr.error,created_by:user.id
      });
      if(!docs.length) return new Response(JSON.stringify({error:"Central de Balanços document query failed",detail:dr.error}),{status:502,headers:H});
      break;
    }
    const items=Array.isArray(dr.data?.items)?dr.data.items:[];
    totalCount=Number(dr.data?.totalCount||items.length);
    docs.push(...items);
    if(!items.length||docs.length>=totalCount||items.length<pageSize) break;
  }

  const unique=[...new Map(docs.filter((d:any)=>d?.id).map((d:any)=>[String(d.id),d])).values()].slice(0,500);
  const evidenceRows=[];
  for(const d of unique){
    const id=String((d as any).id);
    const type=String((d as any).tipoDemonstracao||(d as any).categoria||"Documento");
    const title=String((d as any).titulo||type).trim();
    const desc=String((d as any).descricao||"").trim();
    const publicationDate=safeDate((d as any).dataPublicacao);
    const pdfUrl=API+"/Demonstracao/pdf/"+id;
    const dedupe="central_balancos:"+id;
    evidenceRows.push({
      organization_id:orgId,lead_id:leadId,company_id:companyId,source_registry_id:source?.id||null,
      title:title+" — "+String(company.legal_name||company.trade_name||cnpj),
      source_label:"SPED — Central de Balanços",source_url:pdfUrl,source_kind:"PRIMARY_OFFICIAL",
      document_type:type,publisher:"Sistema Público de Escrituração Digital (SPED)",source_date:publicationDate,
      retrieved_at:new Date().toISOString(),evidence_hash:await sha256(dedupe+"|"+cnpj+"|"+publicationDate),
      dedupe_key:leadId+":"+dedupe,reliability_weight:1,raw_reference:"document_id="+id,
      excerpt:[type,title,desc,(d as any).origem?"Origem: "+(d as any).origem:null].filter(Boolean).join(" | ").slice(0,1800),
      verification_status:"VERIFIED",last_verified_at:new Date().toISOString(),usage_scope:"MENTIONABLE",created_by:user.id
    });
  }

  let evidence:any[]=[];
  for(const batch of sourceBatches(evidenceRows)){
    const er=await admin.from('evidence').upsert(batch,{onConflict:'organization_id,dedupe_key',ignoreDuplicates:true});
    if(er.error)return new Response(JSON.stringify({error:'Evidence persistence failed'}),{status:500,headers:H});
    const read=await admin.from('evidence').select('id,dedupe_key,verification_status').eq('organization_id',orgId).eq('lead_id',leadId).in('dedupe_key',batch.map(e=>e.dedupe_key));
    if(read.error)return new Response(JSON.stringify({error:'Could not load evidence review'}),{status:500,headers:H});
    evidence.push(...(read.data||[]).filter(e=>e.verification_status==='VERIFIED'));
  }
  const evidenceByKey=new Map(evidence.map((x:any)=>[x.dedupe_key,x.id]));

  const {data:existingEvents}=await admin.from("events").select("id,metadata").eq("organization_id",orgId).eq("lead_id",leadId).eq("company_id",companyId);
  const existingKeys=new Map((existingEvents||[]).map((x:any)=>[x.metadata?.source_dedupe_key,x.id]));
  const eventRows=[];
  for(const d of unique){
    const id=String((d as any).id), key="central_balancos:"+id;
    if(existingKeys.has(key)) continue;
    const type=String((d as any).tipoDemonstracao||(d as any).categoria||"Documento");
    const title=String((d as any).titulo||type).trim();
    eventRows.push({
      organization_id:orgId,lead_id:leadId,company_id:companyId,event_type:eventType(d),event_date:safeDate((d as any).dataPublicacao),
      title:title+" publicado na Central de Balanços",
      description:"A fonte oficial confirma a publicação deste documento. O MAX não infere lucro, dividendos, caixa, patrimônio ou liquidez pessoal sem conteúdo explícito que sustente a conclusão.",
      classification:"FACT",confidence:"HIGH",status:"PENDING",
      metadata:{source_dedupe_key:key,central_balancos_document_id:id,document_type:type,origin:(d as any).origem||null,category:(d as any).categoria||null,content_amount_confirmed:false},
      created_by:user.id
    });
  }

  let insertedEvents:any[]=[];
  for(const batch of sourceBatches(eventRows)){
    const ins=await admin.from("events").insert(batch).select("id,metadata");
    if(ins.error) return new Response(JSON.stringify({error:"Event persistence failed",detail:ins.error.message}),{status:500,headers:H});
    insertedEvents.push(...(ins.data||[]));
  }
  for(const ev of insertedEvents) existingKeys.set(ev.metadata?.source_dedupe_key,ev.id);

  const links=[];
  for(const d of unique){
    const key="central_balancos:"+String((d as any).id);
    const evidenceId=evidenceByKey.get(leadId+":"+key),eventId=existingKeys.get(key);
    if(evidenceId&&eventId) links.push({organization_id:orgId,event_id:eventId,evidence_id:evidenceId,support_type:"SUPPORTS",strength:1});
  }
  if(links.length){
    for(const batch of sourceBatches(links)){
    const linkRes=await admin.from("event_evidence").upsert(batch,{onConflict:"event_id,evidence_id"});
    if(linkRes.error) return new Response(JSON.stringify({error:"Event evidence persistence failed",detail:linkRes.error.message}),{status:500,headers:H});
    }
    const verifiedIds=[...new Set(links.map((x:any)=>x.event_id))];
    if(verifiedIds.length) await admin.from("events").update({status:"VERIFIED"}).in("id",verifiedIds).not("status","in","(CONTRADICTED,REJECTED)");
  }

  const now=new Date().toISOString();
  await Promise.all([
    admin.from("source_fetch_logs").insert({
      organization_id:orgId,research_run_id:b.research_run_id||null,source_registry_id:source?.id,
      endpoint_reference:"Central de Balanços /Demonstracao/{participante}/0/0",result_status:"SUCCESS",
      http_status:200,success:true,duration_ms:Date.now()-started,error_summary:null,created_by:user.id
    }),
    admin.from("source_registry").update({
      connection_status:"CONNECTED",last_checked_at:now,
      limitations:"Fonte pública oficial do SPED. Participação/publicação depende do universo coberto pela Central; ausência de documento não prova ausência de demonstrações, lucro, dividendos, patrimônio ou ato societário. O MAX registra metadados/publicações e não presume valores econômicos sem evidência explícita."
    }).eq("key","central_balancos_sped"),
    admin.from("source_sync_state").upsert({
      source_key:"central_balancos_sped",last_attempt_at:now,last_success_at:now,last_status:"SUCCESS",last_error:null,
      records_indexed:unique.length,metadata:{last_cnpj:cnpj,participant_id:participant.id,total_count:totalCount,records_returned:unique.length},updated_at:now
    },{onConflict:"source_key"})
  ]);

  return new Response(JSON.stringify({
    ok:true,participant_found:true,participant_id:participant.id,documents_found:totalCount,
    documents_processed:unique.length,persisted:evidence.length,new_events:insertedEvents.length,truncated:totalCount>unique.length
  }),{headers:H});
});

