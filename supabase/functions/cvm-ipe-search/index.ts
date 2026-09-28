
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { unzipSync } from "npm:fflate@0.8.2";

const H={"Content-Type":"application/json","Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS"};
const cnpjNorm=(v:unknown)=>String(v??"").toUpperCase().replace(/[^A-Z0-9]/g,"");
const cnpjShape=(v:unknown)=>/^[A-Z0-9]{12}[0-9]{2}$/.test(cnpjNorm(v));
const norm=(v:string)=>(v||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]+/g,"_").replace(/^_|_$/g,"");

function scanCsvForCnpj(text:string,targetCnpj:string){
  const matches:any[]=[];
  let headers:string[]|null=null;
  let cnpjIdx=-1;
  let row:string[]=[]; let cur=""; let quoted=false;

  const processRow=()=>{
    row.push(cur);cur="";
    if(!headers){
      headers=row.map(h=>norm(h));
      cnpjIdx=headers.findIndex(k=>k.includes("cnpj"));
      row=[];
      return;
    }
    if(cnpjIdx>=0 && cnpjNorm(row[cnpjIdx])===targetCnpj){
      const obj:any={};
      for(let j=0;j<headers.length;j++) obj[headers[j]]=String(row[j]??"").trim();
      matches.push(obj);
    }
    row=[];
  };

  for(let i=0;i<text.length;i++){
    const ch=text[i];
    if(ch==='"'){
      if(quoted&&text[i+1]==='"'){cur+='"';i++;}
      else quoted=!quoted;
    }else if(ch===';'&&!quoted){
      row.push(cur);cur="";
    }else if((ch==='\n'||ch==='\r')&&!quoted){
      if(ch==='\r'&&text[i+1]==='\n')i++;
      if(cur||row.length) processRow();
    }else cur+=ch;
  }
  if(cur||row.length) processRow();
  return matches;
}

const usefulCategories=[
  "fato_relevante","aviso_aos_acionistas","comunicado_ao_mercado","assembleia",
  "politica_de_dividendos","politica_de_destinacao_de_resultados","reuniao_da_administracao",
  "calendario_de_eventos_corporativos","informacoes_companhias_em_recuperacao_judicial_ou_extrajudicial",
  "informacoes_companhias_em_falencia","informacoes_companhias_em_liquidacao",
  "comunicacao_sobre_transacao_entre_partes_relacionadas","acordo_de_acionistas"
];

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
  const companyId=String(b.company_id||"");
  if(!leadId||!companyId) return new Response(JSON.stringify({error:"lead_id and company_id required"}),{status:400,headers:H});

  const {data:p}=await admin.from("profiles").select("active_organization_id").eq("id",user.id).single();
  const orgId=p?.active_organization_id;
  if(!orgId) return new Response(JSON.stringify({error:"No active organization"}),{status:409,headers:H});

  const {data:lead}=await admin.from("leads").select("id").eq("id",leadId).eq("organization_id",orgId).maybeSingle();
  const {data:company}=await admin.from("companies").select("id,cnpj,legal_name,trade_name").eq("id",companyId).eq("organization_id",orgId).maybeSingle();
  if(!lead||!company) return new Response(JSON.stringify({error:"Lead or company not found"}),{status:404,headers:H});
  const cnpj=cnpjNorm(company.cnpj);
  if(!cnpjShape(cnpj)) return new Response(JSON.stringify({error:"Company has no valid numeric/alphanumeric CNPJ"}),{status:400,headers:H});

  const now=new Date();
  const requested=Array.isArray(b.years)?b.years.map(Number).filter((y:number)=>y>=2003&&y<=now.getUTCFullYear()):[];
  const years=(requested.length?requested:[now.getUTCFullYear()]).slice(0,1);

  const {data:sourceRow}=await admin.from("source_registry").select("id").eq("key","cvm_ipe").single();
  const started=Date.now();
  const matches:any[]=[];

  for(const year of years){
    try{
      const zipUrl=`https://dados.cvm.gov.br/dados/CIA_ABERTA/DOC/IPE/DADOS/ipe_cia_aberta_${year}.zip`;
      const rr=await fetch(zipUrl,{headers:{Accept:"application/zip","User-Agent":"MAX-Intelligence/1.0"}});
      if(!rr.ok) continue;
      const bytes=new Uint8Array(await rr.arrayBuffer());
      const files=unzipSync(bytes);
      const name=Object.keys(files).find(n=>/\.csv$/i.test(n))||Object.keys(files)[0];
      if(!name)continue;
      const text=new TextDecoder("windows-1252").decode(files[name]);
      const rows=scanCsvForCnpj(text,cnpj);
      for(const row of rows){
        const keys=Object.keys(row);
        const cnpjKey=keys.find(k=>k.includes("cnpj"));
        if(!cnpjKey||cnpjNorm(row[cnpjKey])!==cnpj) continue;

        const catKey=keys.find(k=>k==="categoria"||k.includes("categoria"));
        const typeKey=keys.find(k=>k==="tipo"||k.startsWith("tipo_"));
        const speciesKey=keys.find(k=>k.includes("especie"));
        const subjectKey=keys.find(k=>k.includes("assunto"));
        const dateKey=keys.find(k=>k.includes("data_entrega"))||keys.find(k=>k.includes("data_referencia"))||keys.find(k=>k==="data");
        const linkKey=keys.find(k=>k.includes("link"))||keys.find(k=>k.includes("url"));
        const companyNameKey=keys.find(k=>k.includes("nome_companhia"))||keys.find(k=>k.includes("denominacao"));
        const category=String(row[catKey||""]||"").trim();
        const categoryNorm=norm(category);
        const type=String(row[typeKey||""]||"").trim();
        const species=String(row[speciesKey||""]||"").trim();
        const subject=String(row[subjectKey||""]||"").trim();
        const dateRaw=String(row[dateKey||""]||"").trim();
        const sourceDate=(dateRaw.match(/^\d{4}-\d{2}-\d{2}/)||dateRaw.match(/^\d{2}\/\d{2}\/\d{4}/))?.[0]||null;
        const sourceUrl=String(row[linkKey||""]||"").trim()||zipUrl;
        const relevant=usefulCategories.some(x=>categoryNorm.includes(x)) || /dividend|jcp|juros sobre capital|resultado|assembleia|fato relevante|recuperacao|falencia|liquidacao|aquisicao|incorporacao|fusao/i.test([category,type,species,subject].join(" "));
        if(!relevant)continue;

        matches.push({
          year,category,type,species,subject,source_date:sourceDate,source_url:sourceUrl,
          company_name:String(row[companyNameKey||""]||company.legal_name||"").trim()
        });
      }
    }catch(e){console.error("IPE year",year,e)}
  }

  const persisted:any[]=[];
  for(const m of matches.slice(0,80)){
    const rawRef=[m.year,m.category,m.type,m.species,m.subject,m.source_date,m.source_url].join("|");
    const digest=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(rawRef)))).map(x=>x.toString(16).padStart(2,"0")).join("");
    const title=[m.category,m.type,m.species].filter(Boolean).join(" — ").slice(0,240)||"Documento CVM IPE";
    const excerpt=[
      `Companhia: ${m.company_name||company.legal_name||cnpj}`,
      m.category?`categoria: ${m.category}`:null,
      m.type?`tipo: ${m.type}`:null,
      m.species?`espécie: ${m.species}`:null,
      m.subject?`assunto: ${m.subject}`:null,
      m.source_date?`data: ${m.source_date}`:null
    ].filter(Boolean).join("; ")+".";
    const {data:ev,error}=await admin.from("evidence").upsert({
      organization_id:orgId,lead_id:leadId,company_id:companyId,source_registry_id:sourceRow?.id,
      title:`CVM IPE — ${title}`,
      source_label:"CVM — Documentos Periódicos e Eventuais (IPE)",
      source_url:m.source_url||null,source_kind:"PRIMARY_OFFICIAL",
      document_type:"CVM_IPE_FILING",publisher:"Comissão de Valores Mobiliários — CVM",
      source_date:m.source_date,retrieved_at:new Date().toISOString(),
      evidence_hash:digest,dedupe_key:`${leadId}:cvm_ipe:${digest}`,reliability_weight:1,
      raw_reference:rawRef,excerpt,verification_status:"VERIFIED",
      last_verified_at:new Date().toISOString(),usage_scope:"INTERNAL",created_by:user.id
    },{onConflict:"organization_id,dedupe_key"}).select("id").single();
    if(error||!ev)continue;

    const text=[m.category,m.type,m.species,m.subject].join(" ");
    let eventType="CVM_FILING";
    if(/dividend|jcp|juros sobre capital|destinacao de resultados/i.test(text))eventType="DIVIDEND_DISTRIBUTION_DOCUMENT";
    else if(/fato relevante/i.test(text))eventType="MATERIAL_FACT_FILING";
    else if(/assembleia/i.test(text))eventType="SHAREHOLDER_MEETING_FILING";
    else if(/recuperacao judicial|recuperacao extrajudicial/i.test(text))eventType="JUDICIAL_RECOVERY_FILING";
    else if(/falencia/i.test(text))eventType="BANKRUPTCY_FILING";
    else if(/liquidacao/i.test(text))eventType="LIQUIDATION_FILING";

    const eventKey=`cvm_ipe:${digest}`;
    let {data:event}=await admin.from("events").select("id,status")
      .eq("organization_id",orgId).eq("lead_id",leadId).eq("company_id",companyId)
      .eq("event_type",eventType).contains("metadata",{source_dedupe_key:eventKey}).maybeSingle();
    if(!event){
      const ins=await admin.from("events").insert({
        organization_id:orgId,lead_id:leadId,company_id:companyId,event_type:eventType,event_date:m.source_date,
        title:`CVM: ${title}`,description:"Existência do documento confirmada no índice oficial IPE da CVM. O conteúdo econômico específico deve ser interpretado apenas quando o documento-fonte trouxer o dado explicitamente.",
        classification:"FACT",confidence:"HIGH",status:"PENDING",
        metadata:{source_dedupe_key:eventKey,category:m.category,type:m.type,species:m.species,subject:m.subject,content_amount_confirmed:false},
        created_by:user.id
      }).select("id,status").single();
      event=ins.data;
    }
    if(event?.id){
      await admin.from("event_evidence").upsert({organization_id:orgId,event_id:event.id,evidence_id:ev.id,support_type:"SUPPORTS",strength:1},{onConflict:"event_id,evidence_id"});
      await admin.from("events").update({status:"VERIFIED"}).eq("id",event.id).neq("status","CONTRADICTED");
    }
    persisted.push({evidence_id:ev.id,event_id:event?.id||null,...m});
  }

  await admin.from("source_fetch_logs").insert({
    organization_id:orgId,source_registry_id:sourceRow?.id,
    endpoint_reference:"dados.cvm.gov.br/dados/CIA_ABERTA/DOC/IPE/DADOS/ipe_cia_aberta_{year}.zip",
    success:true,http_status:200,result_status:persisted.length?"FILINGS_FOUND":"NO_RELEVANT_FILINGS",
    duration_ms:Date.now()-started,created_by:user.id
  });

  return new Response(JSON.stringify({
    ok:true,cnpj,years,filings_found:persisted.length,filings:persisted.slice(0,10).map((x:any)=>({evidence_id:x.evidence_id,event_id:x.event_id,year:x.year,category:x.category,type:x.type,species:x.species,subject:x.subject,source_date:x.source_date,source_url:x.source_url,company_name:x.company_name})),
    caveat:"O índice IPE confirma que o documento foi entregue à CVM. Valores de dividendos, M&A ou outros efeitos econômicos só podem ser tratados como fato quando estiverem explícitos no documento-fonte."
  }),{headers:H});
});


