
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const H={"Content-Type":"application/json","Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS"};
const norm=(v:any)=>String(v??"").trim();

function domainOf(u:string){
  try{return new URL(u).hostname.toLowerCase().replace(/^www\./,"")}catch{return ""}
}
function resultClass(domain:string,url:string,title:string){
  if(domain==="gov.br"||domain.endsWith(".gov.br")) return "OFFICIAL_GOV";
  if(/linkedin\.com/.test(domain)) return "PROFESSIONAL_PROFILE";
  if(/(g1\.globo\.com|valor\.globo\.com|estadao\.com\.br|folha\.uol\.com\.br|exame\.com|reuters\.com|bloomberg\.com)/.test(domain)) return "NEWS_OR_MEDIA";
  if(/(facebook\.com|instagram\.com|tiktok\.com|x\.com|twitter\.com)/.test(domain)) return "WEB_CANDIDATE";
  if(/empresa|institucional|quem somos|about|grupo|holding/i.test(title+" "+url)) return "CORPORATE_CANDIDATE";
  return "WEB_CANDIDATE";
}

Deno.serve(async(req:Request)=>{
  if(req.method==="OPTIONS")return new Response("ok",{headers:H});
  if(req.method!=="POST")return new Response(JSON.stringify({error:"POST required"}),{status:405,headers:H});
  const auth=req.headers.get("Authorization")||"";
  if(!auth)return new Response(JSON.stringify({error:"Unauthorized"}),{status:401,headers:H});

  const url=Deno.env.get("SUPABASE_URL")!,anon=Deno.env.get("SUPABASE_ANON_KEY")!,service=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const apiKey=Deno.env.get("BRAVE_SEARCH_API_KEY")||"";
  const uc=createClient(url,anon,{global:{headers:{Authorization:auth}}}),admin=createClient(url,service);
  const {data:{user}}=await uc.auth.getUser();
  if(!user)return new Response(JSON.stringify({error:"Unauthorized"}),{status:401,headers:H});

  const b=await req.json().catch(()=>({}));
  const leadId=String(b.lead_id||""),runId=b.research_run_id?String(b.research_run_id):null;
  if(!leadId)return new Response(JSON.stringify({error:"lead_id required"}),{status:400,headers:H});

  const {data:p}=await admin.from("profiles").select("active_organization_id").eq("id",user.id).maybeSingle();
  const orgId=p?.active_organization_id;
  if(!orgId)return new Response(JSON.stringify({error:"No active organization"}),{status:409,headers:H});
  const {data:m}=await admin.from("organization_members").select("role,status").eq("organization_id",orgId).eq("user_id",user.id).maybeSingle();
  if(m?.status!=="ACTIVE")return new Response(JSON.stringify({error:"No organization access"}),{status:403,headers:H});
  if(m.role==="VIEWER")return new Response(JSON.stringify({error:"Viewer is read-only"}),{status:403,headers:H});
  const {data:lead}=await admin.from("leads").select("*").eq("id",leadId).eq("organization_id",orgId).maybeSingle();
  if(!lead)return new Response(JSON.stringify({error:"Lead not found"}),{status:404,headers:H});

  if(!apiKey){
    return new Response(JSON.stringify({
      error:"Web search provider key not configured",
      code:"CONFIG_REQUIRED",
      provider:"BRAVE",
      setup_url:"https://api-dashboard.search.brave.com/app/keys",
      note:"O MAX não simula resultados web; a etapa será ativada quando BRAVE_SEARCH_API_KEY estiver configurada no backend."
    }),{status:428,headers:H});
  }

  const context=[lead.city,lead.state].filter(Boolean).join(" ");
  const queries:string[]=[];
  if(lead.kind==="PERSON"){
    queries.push(`"${lead.name}" ${context}`.trim());
    queries.push(`"${lead.name}" empresa sócio diretor ${context}`.trim());
    if(lead.reference_company)queries.push(`"${lead.name}" "${lead.reference_company}"`);
  }else{
    queries.push(`"${lead.name}" ${context}`.trim());
    queries.push(`"${lead.name}" empresa grupo sócios ${context}`.trim());
  }
  const uniqueQueries=[...new Set(queries.filter(Boolean))].slice(0,3);
  const collected:any[]=[];
  const errors:any[]=[];

  for(const q of uniqueQueries){
    try{
      const endpoint=new URL("https://api.search.brave.com/res/v1/web/search");
      endpoint.searchParams.set("q",q);
      endpoint.searchParams.set("count","10");
      endpoint.searchParams.set("country","BR");
      endpoint.searchParams.set("search_lang","pt-br");
      const rr=await fetch(endpoint,{signal:AbortSignal.timeout(12000),headers:{Accept:"application/json","X-Subscription-Token":apiKey},signal:AbortSignal.timeout(12000)});
      const txt=await rr.text();let data:any=null;
      try{data=txt?JSON.parse(txt):null}catch{data={}}
      if(!rr.ok){errors.push({query:q,status:rr.status,error:data?.message||data?.error||txt.slice(0,300)});continue}
      const rows=Array.isArray(data?.web?.results)?data.web.results:[];
      rows.forEach((x:any,i:number)=>{
        const resultUrl=norm(x.url);if(!resultUrl)return;
        const title=norm(x.title),domain=domainOf(resultUrl);
        collected.push({
          organization_id:orgId,lead_id:leadId,research_run_id:runId,provider:"BRAVE",
          search_query:q,result_rank:i+1,title:title||null,result_url:resultUrl,result_domain:domain||null,
          snippet:norm(x.description||x.extra_snippets?.join(" "))?.slice(0,3000)||null,
          result_class:resultClass(domain,resultUrl,title),validation_status:"PENDING",
          metadata:{age:x.age||null,language:x.language||null,profile:x.profile||null},
          created_by:user.id
        });
      });
    }catch(e){errors.push({query:q,status:0,error:String(e)})}
  }

  const deduped=[...new Map(collected.map(x=>[x.result_url,x])).values()].slice(0,50);
  const persisted:any[]=[];
  for(const row of deduped){
    const {data,error}=await admin.from("web_context_hits").upsert(row,{onConflict:"organization_id,lead_id,result_url"}).select("id,result_url,result_domain,result_class,title,snippet").single();
    if(!error&&data)persisted.push(data);
  }

  const now=new Date().toISOString();
  const {data:source}=await admin.from("source_registry").select("id").eq("key","web_search").maybeSingle();
  await Promise.all([
    admin.from("source_registry").update({
      connection_status:"CONNECTED_LIMITED",last_checked_at:now,
      method:"Brave Search API — discovery layer; results persist as candidates, not confirmed facts.",
      limitations:"Search snippets and rankings are discovery signals only. A URL must be validated against the underlying page/source before supporting a FACT.",
      updated_at:now()
    }).eq("key","web_search"),
    admin.from("source_fetch_logs").insert({
      organization_id:orgId,research_run_id:runId,source_registry_id:source?.id||null,
      endpoint_reference:"api.search.brave.com/res/v1/web/search",
      result_status:errors.length&&persisted.length?"PARTIAL":persisted.length?"SUCCESS":errors.length?"FAILED":"NO_MATCH",
      http_status:errors.length&&persisted.length===0?Number(errors[0]?.status||0)||null:200,
      success:errors.length===0||persisted.length>0,duration_ms:null,
      error_summary:errors.length?JSON.stringify(errors).slice(0,1800):null,created_by:user.id
    })
  ]);

  return new Response(JSON.stringify({
    ok:errors.length===0||persisted.length>0,provider:"BRAVE",queries:uniqueQueries,
    results_found:persisted.length,results:persisted.slice(0,30),errors,
    caveat:"Resultados de busca são candidatos contextuais. Nenhum snippet é promovido automaticamente a fato confirmado."
  }),{status:errors.length&&persisted.length===0?502:200,headers:H});
});

