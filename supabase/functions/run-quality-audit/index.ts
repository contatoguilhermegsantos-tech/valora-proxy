
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
const H={"Content-Type":"application/json"};

Deno.serve(async(req:Request)=>{
  if(req.method!=="POST")return new Response(JSON.stringify({error:"POST required"}),{status:405,headers:H});
  const url=Deno.env.get("SUPABASE_URL")!,service=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin=createClient(url,service);
  const presented=req.headers.get("X-MAX-QUALITY-TOKEN")||"";
  const {data:tok}=await admin.from("system_internal_tokens").select("token").eq("key","quality_watch").maybeSingle();
  if(!tok?.token||tok.token!==presented)return new Response(JSON.stringify({error:"Unauthorized"}),{status:401,headers:H});

  const started=new Date().toISOString();
  const {data:run,error:runErr}=await admin.from("system_quality_runs").insert({status:"RUNNING",started_at:started}).select("id").single();
  if(runErr)return new Response(JSON.stringify({error:runErr.message}),{status:500,headers:H});

  const {data:snapshot,error}=await admin.rpc("max_invariant_snapshot");
  if(error){
    await admin.from("system_quality_runs").update({status:"FAIL",critical_count:1,snapshot:{error:error.message},finished_at:new Date().toISOString()}).eq("id",run.id);
    return new Response(JSON.stringify({ok:false,error:error.message,run_id:run.id}),{status:500,headers:H});
  }

  const critical=Number(snapshot?.critical_count||0),warning=Number(snapshot?.warning_count||0);
  const status=critical>0?"FAIL":warning>0?"WARN":"PASS";
  await admin.from("system_quality_runs").update({
    status,critical_count:critical,warning_count:warning,snapshot:snapshot||{},finished_at:new Date().toISOString()
  }).eq("id",run.id);

  return new Response(JSON.stringify({ok:critical===0,status,critical_count:critical,warning_count:warning,run_id:run.id,snapshot}),{headers:H});
});


