
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const H={"Content-Type":"application/json","Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS"};

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
  const {data:profile}=await admin.from("profiles").select("active_organization_id").eq("id",user.id).maybeSingle();
  const orgId=profile?.active_organization_id;
  if(!orgId) return new Response(JSON.stringify({error:"No active organization"}),{status:409,headers:H});
  const {data:member}=await admin.from("organization_members").select("status,role").eq("organization_id",orgId).eq("user_id",user.id).maybeSingle();
  if(member?.status!=="ACTIVE") return new Response(JSON.stringify({error:"No organization access"}),{status:403,headers:H});
  if(!['OWNER','ADMIN','ANALYST','MEMBER'].includes(member.role))return new Response(JSON.stringify({error:'Operator access required'}),{status:403,headers:H});

  const now=new Date().toISOString();
  const {data:item,error:pickErr}=await admin.from("research_job_queue").select("*")
    .eq("organization_id",orgId).eq("requested_by",user.id)
    .in("status",["PENDING","RETRY"]).lte("next_attempt_at",now)
    .order("priority",{ascending:true}).order("created_at",{ascending:true})
    .limit(1).maybeSingle();
  if(pickErr) return new Response(JSON.stringify({error:pickErr.message}),{status:500,headers:H});
  if(!item) return new Response(JSON.stringify({ok:true,status:"IDLE"}),{headers:H});

  const {data:claimed,error:claimErr}=await admin.from("research_job_queue").update({
    status:"RUNNING",attempts:Number(item.attempts||0)+1,started_at:now,finished_at:null,last_error:null,
    progress:{stage:"RUNNING",message:"Investigação em processamento.",started_at:now},updated_at:now
  }).eq("id",item.id).eq('organization_id',orgId).eq('requested_by',user.id).in("status",["PENDING","RETRY"]).select("*").maybeSingle();
  if(claimErr) return new Response(JSON.stringify({error:claimErr.message}),{status:500,headers:H});
  if(!claimed) return new Response(JSON.stringify({ok:true,status:"RACE_LOST"}),{headers:H});

  let resp:Response|null=null;
  let data:any=null;
  try{
    const isCompanyJob=claimed.job_type==="COMPANY_RESEARCH";
    const fn=isCompanyJob?"company-context-research":"start-research";
    const payload=isCompanyJob
      ? {lead_id:claimed.lead_id,company_id:claimed.company_id}
      : {
          lead_id:claimed.lead_id,
          research_job_id:claimed.id,
          strategy:claimed.strategy,
          cnpj:claimed.payload?.cnpj||undefined,
          objective:claimed.payload?.objective||"Investigação profunda assíncrona baseada em evidências"
        };

    resp=await fetch(url+"/functions/v1/"+fn,{
      method:"POST",
      headers:{Authorization:auth,"Content-Type":"application/json"},
      body:JSON.stringify(payload)
    });
    const raw=await resp.text();
    try{data=raw?JSON.parse(raw):null}catch{data={error:"Invalid JSON",raw:raw.slice(0,500)}}
  }catch(e){
    data={error:String(e)};
  }

  const finished=new Date().toISOString();
  let finalStatus="COMPLETED";
  if(resp?.ok&&data?.research_run_id){
    if(!data.history_capture?.ok){
      try{const history=await fetch(url+'/functions/v1/capture-intelligence',{method:'POST',headers:{Authorization:auth,'Content-Type':'application/json'},body:JSON.stringify({lead_id:claimed.lead_id,research_run_id:data.research_run_id}),signal:AbortSignal.timeout(25000)});data.history_capture=await history.json();}catch{data.history_capture={ok:false,error:'History capture pending; retry from dossier'};}
    }
    const saved=await admin.from("research_job_queue").update({
      status:"COMPLETED",finished_at:finished,updated_at:finished,
      progress:{stage:"COMPLETED",message:claimed.job_type==="COMPANY_RESEARCH"?"Pesquisa profunda da empresa concluída.":"Investigação concluída.",research_run_id:data.research_run_id,research_status:data.status||null,company_id:claimed.company_id||null},
      result:data,last_error:null
    }).eq("id",claimed.id).eq('organization_id',orgId).eq('requested_by',user.id).eq('status','RUNNING').select('id').maybeSingle();
    if(saved.error||!saved.data)return new Response(JSON.stringify({error:'Could not finalize completed research job',job_id:claimed.id}),{status:500,headers:H});
  }else{
    // start-research binds its run before calling sources. A lost HTTP response must retain that exact run.
    if(!data?.research_run_id){
      const current=await admin.from('research_job_queue').select('progress').eq('id',claimed.id).eq('organization_id',orgId).eq('requested_by',user.id).eq('status','RUNNING').maybeSingle();
      if(current.error)return new Response(JSON.stringify({error:'Could not preserve research job progress',job_id:claimed.id}),{status:500,headers:H});
      if(current.data?.progress?.research_run_id)data={...(data||{}),research_run_id:current.data.progress.research_run_id};
    }
    const attempt=Number(claimed.attempts||1),maxAttempts=Number(claimed.max_attempts||3);
    const willRetry=attempt<maxAttempts;
    const next=new Date(Date.now()+Math.min(15,Math.pow(2,attempt))*60_000).toISOString();
    const err=String(data?.error||data?.detail||("HTTP "+(resp?.status||0))).slice(0,2000);
    finalStatus=willRetry?"RETRY":"FAILED";
    const saved=await admin.from("research_job_queue").update({
      status:finalStatus,next_attempt_at:willRetry?next:claimed.next_attempt_at,
      finished_at:willRetry?null:finished,updated_at:finished,last_error:err,
      progress:{stage:finalStatus,message:willRetry?"Falhou; nova tentativa agendada.":"Pesquisa falhou após o limite de tentativas.",research_run_id:data?.research_run_id||null,next_attempt_at:willRetry?next:null}
    }).eq("id",claimed.id).eq('organization_id',orgId).eq('requested_by',user.id).eq('status','RUNNING').select('id').maybeSingle();
    if(saved.error||!saved.data)return new Response(JSON.stringify({error:'Could not save research retry state',job_id:claimed.id}),{status:500,headers:H});
  }

  const {count:remaining}=await admin.from("research_job_queue").select("*",{count:"exact",head:true})
    .eq("organization_id",orgId).eq("requested_by",user.id).in("status",["PENDING","RETRY"]).lte("next_attempt_at",new Date().toISOString());
  if((remaining||0)>0){
    const p=fetch(url+"/functions/v1/research-queue-worker",{
      method:"POST",headers:{Authorization:auth,"Content-Type":"application/json"},body:"{}"
    }).catch(()=>null);
    const er=(globalThis as any).EdgeRuntime;
    if(er?.waitUntil) er.waitUntil(p);
  }

  return new Response(JSON.stringify({ok:finalStatus==="COMPLETED",status:finalStatus,job_id:claimed.id,research_run_id:data?.research_run_id||null,remaining_ready:remaining||0}),{status:finalStatus==="FAILED"?502:200,headers:H});
});
