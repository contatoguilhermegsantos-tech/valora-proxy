import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { summarizeSourceHealth, summarizeQualityRun } from "../_shared/source-operations.ts";
const H={"Content-Type":"application/json","Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS"};
Deno.serve(async(req:Request)=>{
 if(req.method==="OPTIONS")return new Response("ok",{headers:H});
 if(req.method!=="POST")return new Response(JSON.stringify({error:"POST required"}),{status:405,headers:H});
 const auth=req.headers.get("Authorization")||"";
 const url=Deno.env.get("SUPABASE_URL")!;
 const client=createClient(url,Deno.env.get("SUPABASE_ANON_KEY")!,{global:{headers:{Authorization:auth}}});
 const {data:{user}}=await client.auth.getUser();
 if(!user)return new Response(JSON.stringify({error:"Unauthorized"}),{status:401,headers:H});
 const admin=createClient(url,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
 const {data:p}=await admin.from("profiles").select("active_organization_id").eq("id",user.id).maybeSingle();
 const {data:m}=await admin.from("organization_members").select("status").eq("organization_id",p?.active_organization_id||"00000000-0000-0000-0000-000000000000").eq("user_id",user.id).maybeSingle();
 if(m?.status!=="ACTIVE")return new Response(JSON.stringify({error:"No organization access"}),{status:403,headers:H});
 // Only operational source metadata, never tokens, connector payloads or tenant records.
 const since=new Date(Date.now()-48*3600000).toISOString();
 const [sources,backlog,sync,backfill,quality,logs]=await Promise.all([
  admin.from("source_registry").select("id,key,name,category,source_tier,domain,connection_status,limitations,coverage_notes,action_url").order("name"),
  admin.from("source_candidate_backlog").select("id,source_key,source_name,source_url,category,intended_use,official_or_primary,auth_requirement,coverage_notes,limitations,status,priority,updated_at").order("priority"),
  admin.from("source_sync_state").select("source_key,last_successful_date,last_status,last_attempt_at,last_success_at"),
  admin.from("source_backfill_queue").select("source_key,target_date,status,attempts").order("target_date"),
  admin.from("system_quality_runs").select("status,critical_count,warning_count,finished_at,snapshot").neq("status","RUNNING").order("finished_at",{ascending:false}).limit(1).maybeSingle(),
  admin.from("source_fetch_logs").select("source_registry_id,result_status,success,duration_ms,queried_at").eq("organization_id",p.active_organization_id).gte("queried_at",since).order("queried_at",{ascending:false}).limit(500)
 ]);
 const error=[sources,backlog,sync,backfill,quality,logs].find(r=>r.error)?.error;
 if(error)return new Response(JSON.stringify({error:error.message}),{status:500,headers:H});
 return new Response(JSON.stringify({sources:sources.data,backlog:backlog.data,sync:sync.data,backfill:backfill.data,quality:summarizeQualityRun(quality.data),health:summarizeSourceHealth(logs.data||[]),observation:{since,checked_at:new Date().toISOString(),sample_limit:500,sample_limited:logs.data?.length===500}}),{headers:H});
});
