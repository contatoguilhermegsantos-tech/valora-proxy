
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { fetchSourceJson, selectTerritory, searchOutcome } from "../_shared/source-operations.ts";

const H={"Content-Type":"application/json","Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS"};
const norm=(v:string)=>(v||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9 ]/g," ").replace(/\s+/g," ").trim();
const strip=(v:string)=>(v||"").replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim();
const digits=(v:string)=>(v||"").toUpperCase().replace(/[^A-Z0-9]/g,"");
const API="https://api.queridodiario.org.br";

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
  const {data:member}=await admin.from("organization_members").select("status,role").eq("organization_id",orgId).eq("user_id",user.id).maybeSingle();
  if(member?.status!=="ACTIVE"||member.role==="VIEWER")return new Response(JSON.stringify({error:"No research permission"}),{status:403,headers:H});

  const {data:lead}=await admin.from("leads").select("*").eq("id",leadId).eq("organization_id",orgId).maybeSingle();
  if(!lead) return new Response(JSON.stringify({error:"Lead not found"}),{status:404,headers:H});

  const {data:sourceRow}=await admin.from("source_registry").select("id").eq("key","querido_diario").single();
  const started=Date.now();

  async function stop(result:string,note:string,httpStatus:number|null=null,responseStatus=200){
    await admin.from("source_fetch_logs").insert({organization_id:orgId,source_registry_id:sourceRow?.id,endpoint_reference:API+"/cities",success:result==="CITY_NOT_COVERED_CONFIRMED",http_status:httpStatus,result_status:result,error_summary:note,duration_ms:Date.now()-started,created_by:user.id});
    return new Response(JSON.stringify({ok:responseStatus===200,status:result,territory_found:false,results:[],note}),{status:responseStatus,headers:H});
  }
  if(!String(lead.city||"").trim())return stop("CITY_REQUIRED","Informe o município para consultar os diários locais.");
  const cities=await fetchSourceJson(API+"/cities?city_name="+encodeURIComponent(String(lead.city).trim()),v=>Array.isArray(v)||Array.isArray(v?.cities));
  if(!cities.ok)return stop("CITY_LOOKUP_FAILED","Consulta de municípios indisponível: "+cities.error,cities.status,502);
  const selected=selectTerritory(Array.isArray(cities.data)?cities.data:cities.data.cities,String(lead.city),String(lead.state||""));
  if(selected.ambiguous)return stop("CITY_AMBIGUOUS","Município ambíguo; informe a UF.",cities.status);
  const city=selected.city;
  const territoryId=String(city?.territory_id||city?.id||"");
  if(!territoryId){
    return stop("CITY_NOT_COVERED_CONFIRMED","Município/UF não encontrado na resposta válida de cobertura do Querido Diário.",cities.status);
  }

  const {data:links}=await admin.from("lead_company_links").select("company_id,companies(cnpj,legal_name,trade_name)").eq("lead_id",leadId).eq("organization_id",orgId).neq("status","REJECTED");
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
  if(!uniq.length)return stop("NO_SEARCH_TERMS","Não há termos suficientes para a pesquisa.",cities.status);
  let completed=0,failed=0,lastHttp:number|null=null;

  for(const term of uniq){
    try{
      const qs=new URLSearchParams({
        territory_ids:territoryId,
        querystring:term,
        excerpt_size:"700",
        number_of_excerpts:"3",
        size:String(Math.min(maxResults,10))
      });
      const rr=await fetchSourceJson(`${API}/gazettes?${qs.toString()}`,v=>Array.isArray(v?.gazettes));
      lastHttp=rr.status;
      if(!rr.ok){failed++;continue;}
      const gazettes=rr.data.gazettes;
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
        // Insert-only conflict handling preserves reviewed evidence even during concurrent re-search.
        const {error}=await admin.from("evidence").upsert(payload,{onConflict:"organization_id,dedupe_key",ignoreDuplicates:true});
        if(error)throw error;
        const {data:ev,error:readError}=await admin.from("evidence").select("id,title,source_url,source_date,excerpt,verification_status").eq("organization_id",orgId).eq("dedupe_key",payload.dedupe_key).single();
        if(readError)throw readError;
        if(ev && !["REJECTED","CONTRADICTED"].includes(ev.verification_status))persisted.push({...ev,query:term,territory_id:territoryId});
      }
      completed++;
    }catch{failed++;}
  }

  if(persisted.length){
    const {data:existingQ}=await admin.from("investigation_questions").select("id").eq("organization_id",orgId).eq("lead_id",leadId).eq("question_type","MUNICIPAL_GAZETTE_CONTEXT").eq("status","OPEN").maybeSingle();
    if(!existingQ) await admin.from("investigation_questions").insert({
      organization_id:orgId,lead_id:leadId,question_type:"MUNICIPAL_GAZETTE_CONTEXT",
      question:"As menções encontradas em diários oficiais municipais representam contrato, nomeação, ato societário, licitação, pagamento ou apenas citação contextual? Validar o documento antes de transformar em fato.",
      status:"OPEN",created_by:user.id
    });
  }

  const outcome=searchOutcome(completed,failed,persisted.length);
  await admin.from("source_fetch_logs").insert({
    organization_id:orgId,source_registry_id:sourceRow?.id,
    endpoint_reference:API+"/gazettes",
    success:failed===0,http_status:lastHttp,result_status:outcome,
    error_summary:failed?`${failed} consulta(s) não concluída(s); não interpretar como ausência de menções.`:null,
    duration_ms:Date.now()-started,created_by:user.id
  });

  return new Response(JSON.stringify({
    ok:completed>0,status:outcome,queries_completed:completed,queries_failed:failed,territory_found:true,territory_id:territoryId,
    territory_name:city?.territory_name||lead.city,
    terms_searched:uniq,
    mentions_found:persisted.length,
    evidence:persisted,
    caveat:"Menção em diário municipal é evidência de publicação, não prova por si só relação econômica, pagamento, parentesco ou patrimônio."
  }),{status:completed?200:502,headers:H});
});
