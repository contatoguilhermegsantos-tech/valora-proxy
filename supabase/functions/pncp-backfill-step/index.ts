import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
const H={"Content-Type":"application/json"};
Deno.serve(async(req:Request)=>{
 if(req.method!=="POST")return new Response(JSON.stringify({error:"POST required"}),{status:405,headers:H});
 const url=Deno.env.get("SUPABASE_URL")!,admin=createClient(url,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
 const {data:tok}=await admin.from("system_internal_tokens").select("token").eq("key","pncp_sync").maybeSingle();
 if(!tok?.token||req.headers.get("X-MAX-SYNC-TOKEN")!==tok.token)return new Response(JSON.stringify({error:"Unauthorized"}),{status:401,headers:H});
 // A killed worker may not run its catch block. Recover only after its execution deadline.
 const {error:recoveryError}=await admin.from("source_backfill_queue").update({status:"FAILED",last_error:"Worker lease expired; checkpoint retained",finished_at:new Date().toISOString()}).eq("source_key","pncp").eq("status","RUNNING").lt("started_at",new Date(Date.now()-10*60000).toISOString());
 if(recoveryError)return new Response(JSON.stringify({error:"Could not recover worker leases"}),{status:500,headers:H});
 // Four failures trigger a six-hour cooldown, not permanent abandonment of a daily gap.
 const {error:cooldownError}=await admin.from("source_backfill_queue").update({attempts:0}).eq("source_key","pncp").eq("status","FAILED").gte("attempts",4).lt("finished_at",new Date(Date.now()-6*3600000).toISOString());
 if(cooldownError)return new Response(JSON.stringify({error:"Could not recover cooled-down dates"}),{status:500,headers:H});
 const {data:item,error:selectionError}=await admin.from("source_backfill_queue").select("*").eq("source_key","pncp").in("status",["PENDING","FAILED"]).lt("attempts",4).order("target_date",{ascending:true}).limit(1).maybeSingle();
 if(selectionError)return new Response(JSON.stringify({error:"Could not read source queue"}),{status:500,headers:H});
 if(!item)return new Response(JSON.stringify({ok:true,status:"IDLE"}),{headers:H});
 const started=new Date().toISOString();
 // Compare-and-set: concurrent invocations cannot claim the same date.
 const {data:claimed,error:claimError}=await admin.from("source_backfill_queue").update({status:"RUNNING",attempts:Number(item.attempts)+1,started_at:started,finished_at:null,last_error:null}).eq("id",item.id).eq("status",item.status).eq("attempts",item.attempts).select("id").maybeSingle();
 if(claimError)return new Response(JSON.stringify({error:"Could not claim source date"}),{status:500,headers:H});
 if(!claimed)return new Response(JSON.stringify({ok:true,status:"BUSY"}),{headers:H});
 let data:any;
 try{
  const resp=await fetch(url+"/functions/v1/pncp-sync-contracts",{method:"POST",headers:{"Content-Type":"application/json","X-MAX-SYNC-TOKEN":tok.token},body:JSON.stringify({date_from:item.target_date,date_to:item.target_date,queue_id:item.id}),signal:AbortSignal.timeout(110000)});
  data=await resp.json();
  if(!resp.ok&&data?.status!=="FAILED")data={status:"FAILED",error:"Sync endpoint HTTP "+resp.status};
 }catch{data={status:"FAILED",error:"Sync request failed or timed out; checkpoint retained"}}
 const {data:checkpoint,error:checkpointError}=await admin.from("source_backfill_queue").select("next_page").eq("id",item.id).single();
 if(checkpointError)return new Response(JSON.stringify({error:"Could not read checkpoint; lease will recover"}),{status:500,headers:H});
 const progressed=Number(checkpoint.next_page)>Number(item.next_page);
 const successful=data?.status==="SUCCESS";
 const continuing=data?.status==="PARTIAL"&&progressed;
 const state=successful?"DONE":continuing?"PENDING":"FAILED";
 const {error:finishError}=await admin.from("source_backfill_queue").update({status:state,attempts:successful||progressed?0:Number(item.attempts)+1,finished_at:new Date().toISOString(),last_error:successful?null:String(data?.error||"Incomplete source response").slice(0,500)}).eq("id",item.id).eq("status","RUNNING").eq("started_at",started);
 if(finishError)return new Response(JSON.stringify({error:"Could not finalize worker; lease will recover"}),{status:500,headers:H});
 return new Response(JSON.stringify({ok:state!=="FAILED",status:state,date:item.target_date,next_page:checkpoint.next_page,detail:data}),{status:state==="FAILED"?502:200,headers:H});
});

