
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const H={"Content-Type":"application/json","Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS"};
const norm=(v:string)=>(v||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9 ]/g," ").replace(/\s+/g," ").trim();
const strip=(v:string)=>(v||"").replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim();
const digits=(v:string)=>(v||"").replace(/\D/g,"");

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
  const maxResults=Math.max(1,Math.min(Number(b.max_results||10),20));
  if(!leadId) return new Response(JSON.stringify({error:"lead_id required"}),{status:400,headers:H});

  const {data:p}=await admin.from("profiles").select("active_organization_id").eq("id",user.id).single();
  const orgId=p?.active_organization_id;
  if(!orgId) return new Response(JSON.stringify({error:"No active organization"}),{status:409,headers:H});

  const {data:lead}=await admin.from("leads").select("*").eq("id",leadId).eq("organization_id",orgId).maybeSingle();
  if(!lead) return new Response(JSON.stringify({error:"Lead not found"}),{status:404,headers:H});

  const {data:sourceRow}=await admin.from("source_registry").select("id").eq("key","querido_diario").single();
  const started=Date.now();

  let cityCandidates:any[]=[];
  try{
    const q=encodeURIComponent(String(lead.city||"").trim());
    if(q){
      const cr=await fetch(`https://api.queridodiario.ok.org.br/cities?city_name=${q}`,{headers:{Accept:"application/json"}});
      if(cr.ok){
        const cj=await cr.json();
        cityCandidates=Array.isArray(cj)?cj:(Array.isArray(cj?.cities)?cj.cities:[]);
      }
    }
  }catch{}

  const targetCity=norm(String(lead.city||""));
  const targetState=String(lead.state||"").toUpperCase();
  let city=cityCandidates.find((c:any)=>norm(String(c.territory_name||c.name||c.city_name||""))===targetCity && String(c.state_code||c.state||"").toUpperCase()===targetState)
        || cityCandidates.find((c:any)=>norm(String(c.territory_name||c.name||c.city_name||""))===targetCity)
        || cityCandidates[0];

  const territoryId=String(city?.territory_id||city?.id||"");
  if(!territoryId){
    await admin.from("source_fetch_logs").insert({organization_id:orgId,source_registry_id:sourceRow?.id,endpoint_reference:"api.queridodiario.ok.org.br/cities",success:false,result_status:"CITY_NOT_COVERED",error_summary:"Município não encontrado/coberto no Querido Diário",duration_ms:Date.now()-started,created_by:user.id});
    return new Response(JSON.stringify({ok:true,territory_found:false,results:[],note:"Município não encontrado na cobertura do Querido Diário."}),{headers:H});
  }

  const {data:links}=await admin.from("lead_company_links").select("company_id,companies(cnpj,legal_name,trade_name)").eq("lead_id",leadId).eq("organization_id",orgId);
  const terms:string[]=[];
  if(lead.name) terms.push(String(lead.name).trim());
  for(const l of links||[]){
    const c:any=(l as any).companies;
    if(c?.legal_name) terms.push(String(c.legal_name).trim());
    if(c?.trade_name && norm(c.trade_name)!==norm(c.legal_name)) terms.push(String(c.trade_name).trim());
    if(c?.cnpj) terms.push(digits(String(c.cnpj)));
  }
  if(Array.isArray(b.terms)) for(const t of b.terms) if(String(t||"").trim()) terms.push(String(t).trim());

  const uniq=[...new Map(terms.filter(x=>x.length>=4).map(x=>[norm(x),x])).values()].slice(0,4);
  const persisted:any[]=[];
  const seen=new Set<string>();

  for(const term of uniq){
    try{
      const qs=new URLSearchParams({
        territory_ids:territoryId,
        querystring:term,
        excerpt_size:"700",
        number_of_excerpts:"3",
        size:String(Math.min(maxResults,10))
      });
      const rr=await fetch(`https://api.queridodiario.ok.org.br/gazettes?${qs.toString()}`,{headers:{Accept:"application/json"}});
      if(!rr.ok) continue;
      const jj=await rr.json();
      const gazettes=Array.isArray(jj?.gazettes)?jj.gazettes:[];
      for(const g of gazettes){
        const srcUrl=String(g.url||g.file_url||g.source_url||"");
        const date=String(g.date||g.published_at||"").slice(0,10)||null;
        const k=`${srcUrl}|${norm(term)}`;
        if(seen.has(k)) continue; seen.add(k);
        let ex:any[]=Array.isArray(g.excerpts)?g.excerpts:[];
        if(!ex.length && g.excerpt) ex=[g.excerpt];
        if(!ex.length && g.text_excerpt) ex=[g.text_excerpt];
        const excerpt=strip(ex.map((x:any)=>typeof x==="string"?x:(x?.text||x?.excerpt||JSON.stringify(x))).join(" … ")).slice(0,3500);
        const keyMaterial=`querido_diario|${territoryId}|${srcUrl}|${term}`;
        const bytes=new TextEncoder().encode(keyMaterial);
        const hash=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes))).map(x=>x.toString(16).padStart(2,"0")).join("");
        const territoryName=String(g.territory_name||city?.territory_name||lead.city||"Município");
        const stateCode=String(g.state_code||city?.state_code||lead.state||"");
        const payload={
          organization_id:orgId,lead_id:leadId,source_registry_id:sourceRow?.id,
          title:`Menção em Diário Oficial Municipal — ${territoryName}/${stateCode}`,
          source_label:"Querido Diário — Diários Oficiais Municipais",
          source_url:srcUrl||null,
          source_kind:"AGGREGATOR",
          document_type:"MUNICIPAL_GAZETTE_MENTION",
          publisher:`Querido Diário / Diário Oficial de ${territoryName}`,
          source_date:date,
          retrieved_at:new Date().toISOString(),
          evidence_hash:hash,
          dedupe_key:`${leadId}:querido_diario:${hash}`,
          reliability_weight:0.8,
          raw_reference:`territory_id=${territoryId}; query=${term}`,
          excerpt:excerpt||`O termo "${term}" foi localizado em edição do Diário Oficial Municipal.`,
          verification_status:"PENDING",
          last_verified_at:null,
          usage_scope:"INTERNAL",
          created_by:user.id
        };
        const {data:ev,error}=await admin.from("evidence").upsert(payload,{onConflict:"organization_id,dedupe_key"}).select("id,title,source_url,source_date,excerpt,verification_status").single();
        if(!error && ev) persisted.push({...ev,query:term,territory_id:territoryId});
      }
    }catch{}
  }

  if(persisted.length){
    const {data:existingQ}=await admin.from("investigation_questions").select("id").eq("organization_id",orgId).eq("lead_id",leadId).eq("question_type","MUNICIPAL_GAZETTE_CONTEXT").eq("status","OPEN").maybeSingle();
    if(!existingQ) await admin.from("investigation_questions").insert({
      organization_id:orgId,lead_id:leadId,question_type:"MUNICIPAL_GAZETTE_CONTEXT",
      question:"As menções encontradas em diários oficiais municipais representam contrato, nomeação, ato societário, licitação, pagamento ou apenas citação contextual? Validar o documento antes de transformar em fato.",
      status:"OPEN",created_by:user.id
    });
  }

  await admin.from("source_fetch_logs").insert({
    organization_id:orgId,source_registry_id:sourceRow?.id,
    endpoint_reference:"api.queridodiario.ok.org.br/gazettes",
    success:true,http_status:200,result_status:persisted.length?"MENTIONS_FOUND":"NO_MENTIONS",
    duration_ms:Date.now()-started,created_by:user.id
  });

  return new Response(JSON.stringify({
    ok:true,territory_found:true,territory_id:territoryId,
    territory_name:city?.territory_name||lead.city,
    terms_searched:uniq,
    mentions_found:persisted.length,
    evidence:persisted,
    caveat:"Menção em diário municipal é evidência de publicação, não prova por si só relação econômica, pagamento, parentesco ou patrimônio."
  }),{headers:H});
});


