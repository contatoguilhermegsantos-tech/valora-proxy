
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const H={"Content-Type":"application/json","Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS"};
const cnpjNorm=(v:unknown)=>String(v??"").toUpperCase().replace(/[^A-Z0-9]/g,"");

function dispatchWorker(url:string,auth:string){
  const p=fetch(url+"/functions/v1/research-queue-worker",{method:"POST",headers:{Authorization:auth,"Content-Type":"application/json"},body:"{}"}).catch(()=>null);
  const er=(globalThis as any).EdgeRuntime;
  if(er?.waitUntil) er.waitUntil(p);
}
function inferStrategy(lead:any){
  const seg=String(lead?.segment||"").toLowerCase();
  if(/agro|rural|fazenda|pecu|agric|sement/.test(seg)) return "AGRO";
  if(/medic|saude|saúde|clinic|hospital|odont/.test(seg)) return "MEDICO";
  if(lead?.kind==="COMPANY") return "EMPRESARIO";
  return "GENERICO";
}

Deno.serve(async(req:Request)=>{
  if(req.method==="OPTIONS") return new Response("ok",{headers:H});
  if(req.method!=="POST") return new Response(JSON.stringify({error:"POST required"}),{status:405,headers:H});

  const auth=req.headers.get("Authorization")||"";
  if(!auth) return new Response(JSON.stringify({error:"Unauthorized"}),{status:401,headers:H});

  const url=Deno.env.get("SUPABASE_URL")!,anon=Deno.env.get("SUPABASE_ANON_KEY")!,service=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const uc=createClient(url,anon,{global:{headers:{Authorization:auth}}});
  const admin=createClient(url,service);
  const {data:{user}}=await uc.auth.getUser();
  if(!user) return new Response(JSON.stringify({error:"Unauthorized"}),{status:401,headers:H});

  const b=await req.json().catch(()=>({}));
  const action=String(b.action||"list").toLowerCase();
  const {data:profile}=await admin.from("profiles").select("active_organization_id").eq("id",user.id).maybeSingle();
  const orgId=profile?.active_organization_id;
  if(!orgId) return new Response(JSON.stringify({error:"No active organization"}),{status:409,headers:H});
  const {data:member}=await admin.from("organization_members").select("role,status").eq("organization_id",orgId).eq("user_id",user.id).maybeSingle();
  if(member?.status!=="ACTIVE") return new Response(JSON.stringify({error:"No organization access"}),{status:403,headers:H});

  if(action==="list"){
    let q=admin.from("research_job_queue").select("*,companies(legal_name,trade_name,cnpj)").eq("organization_id",orgId).order("created_at",{ascending:false}).limit(Math.max(1,Math.min(Number(b.limit||100),200)));
    if(b.lead_id) q=q.eq("lead_id",String(b.lead_id));
    const {data,error}=await q;
    if(error) return new Response(JSON.stringify({error:error.message}),{status:500,headers:H});
    if((data||[]).some((x:any)=>["PENDING","RETRY"].includes(x.status))) dispatchWorker(url,auth);
    return new Response(JSON.stringify({ok:true,jobs:data||[]}),{headers:H});
  }

  if(action==="cancel"){
    if(member.role==="VIEWER") return new Response(JSON.stringify({error:"Viewer is read-only"}),{status:403,headers:H});
    const id=String(b.job_id||"");
    const {data,error}=await admin.from("research_job_queue").update({
      status:"CANCELLED",finished_at:new Date().toISOString(),updated_at:new Date().toISOString()
    }).eq("id",id).eq("organization_id",orgId).in("status",["PENDING","RETRY"]).select("id,status").maybeSingle();
    if(error) return new Response(JSON.stringify({error:error.message}),{status:500,headers:H});
    return new Response(JSON.stringify({ok:true,job:data||null}),{headers:H});
  }

  if(action!=="enqueue") return new Response(JSON.stringify({error:"Unknown action"}),{status:400,headers:H});
  if(member.role==="VIEWER") return new Response(JSON.stringify({error:"Viewer is read-only"}),{status:403,headers:H});

  const ids=[...new Set([
    ...(Array.isArray(b.lead_ids)?b.lead_ids:[]),
    ...(b.lead_id?[b.lead_id]:[])
  ].map((x:any)=>String(x||"")).filter(Boolean))].slice(0,100);
  if(!ids.length) return new Response(JSON.stringify({error:"lead_id or lead_ids required"}),{status:400,headers:H});

  const {data:leads,error:leadErr}=await admin.from("leads").select("id,kind,segment,initial_cnpj").eq("organization_id",orgId).in("id",ids);
  if(leadErr) return new Response(JSON.stringify({error:leadErr.message}),{status:500,headers:H});
  const found=new Map((leads||[]).map((l:any)=>[l.id,l]));
  const created:any[]=[],existing:any[]=[],missing:string[]=[];

  for(const id of ids){
    const lead:any=found.get(id);
    if(!lead){missing.push(id);continue}
    const {data:active}=await admin.from("research_job_queue").select("id,status,strategy,created_at")
      .eq("organization_id",orgId).eq("lead_id",id).eq("job_type","LEAD_RESEARCH")
      .in("status",["PENDING","RUNNING","RETRY"]).order("created_at",{ascending:false}).limit(1).maybeSingle();
    if(active){existing.push(active);continue}

    const requested=String(b.strategy||"").toUpperCase();
    const strategy=["EMPRESARIO","AGRO","MEDICO","GENERICO"].includes(requested)?requested:inferStrategy(lead);
    const payload={
      objective:b.objective||"Investigação profunda assíncrona baseada em evidências",
      cnpj:cnpjNorm(b.cnpj||lead.initial_cnpj)||null,
      source:"research_queue",
      ...(b.payload&&typeof b.payload==="object"?b.payload:{})
    };
    const {data:job,error}=await admin.from("research_job_queue").insert({
      organization_id:orgId,lead_id:id,requested_by:user.id,job_type:"LEAD_RESEARCH",
      strategy,payload,status:"PENDING",priority:Number.isFinite(Number(b.priority))?Number(b.priority):100,
      progress:{stage:"QUEUED",message:"Pesquisa aguardando processamento."}
    }).select("*").single();
    if(error){
      if(String(error.code)==="23505"){
        const {data:race}=await admin.from("research_job_queue").select("*").eq("organization_id",orgId).eq("lead_id",id).eq("job_type","LEAD_RESEARCH").in("status",["PENDING","RUNNING","RETRY"]).maybeSingle();
        if(race) existing.push(race);
      } else return new Response(JSON.stringify({error:error.message}),{status:500,headers:H});
    } else created.push(job);
  }

  if(created.length||existing.some((x:any)=>["PENDING","RETRY"].includes(x.status))) dispatchWorker(url,auth);
  return new Response(JSON.stringify({ok:true,created,existing,missing,queued:created.length,processing_started:Boolean(created.length||existing.length)}),{headers:H});
});


