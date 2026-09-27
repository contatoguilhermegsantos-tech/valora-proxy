
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
const H={"Content-Type":"application/json"};

Deno.serve(async(req:Request)=>{
 if(req.method!=="POST")return new Response(JSON.stringify({error:"POST required"}),{status:405,headers:H});
 const url=Deno.env.get("SUPABASE_URL")!,service=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
 const admin=createClient(url,service);
 const presented=req.headers.get("X-MAX-SYNC-TOKEN")||"";
 const {data:tok}=await admin.from("system_internal_tokens").select("token").eq("key","pncp_sync").maybeSingle();
 if(!tok?.token||presented!==tok.token)return new Response(JSON.stringify({error:"Unauthorized"}),{status:401,headers:H});

 const {data:item}=await admin.from("source_backfill_queue").select("*").eq("source_key","pncp").in("status",["PENDING","FAILED"]).lt("attempts",4).order("target_date",{ascending:true}).limit(1).maybeSingle();
 if(!item)return new Response(JSON.stringify({ok:true,status:"IDLE",message:"No pending backfill dates"}),{headers:H});

 await admin.from("source_backfill_queue").update({status:"RUNNING",attempts:Number(item.attempts||0)+1,started_at:new Date().toISOString(),finished_at:null,last_error:null}).eq("id",item.id);
 let resp:Response;
 let data:any=null;
 let raw="";
 try{
  resp=await fetch(url+"/functions/v1/pncp-sync-contracts",{method:"POST",headers:{"Content-Type":"application/json","X-MAX-SYNC-TOKEN":tok.token},body:JSON.stringify({date_from:item.target_date,date_to:item.target_date,max_pages:25})});
  raw=await resp.text();
  if(raw.trim()){
   try{data=JSON.parse(raw)}
   catch(e){data={status:"FAILED",error:"Invalid/truncated JSON from pncp-sync-contracts: "+String(e),raw_preview:raw.slice(0,300)}}
  }else data={status:"FAILED",error:"Empty response body from pncp-sync-contracts"};
 }catch(e){
  await admin.from("source_backfill_queue").update({status:"FAILED",last_error:"Worker fetch error: "+String(e),finished_at:new Date().toISOString()}).eq("id",item.id);
  return new Response(JSON.stringify({ok:false,status:"FAILED",date:item.target_date,error:String(e)}),{status:502,headers:H});
 }

 const successful=resp.ok&&data?.status==="SUCCESS";
 if(!successful){
  const error=data?.error||("Upstream status "+String(data?.status||"UNKNOWN")+" / HTTP "+resp.status);
  await admin.from("source_backfill_queue").update({status:"FAILED",last_error:error,finished_at:new Date().toISOString()}).eq("id",item.id);
  return new Response(JSON.stringify({ok:false,status:"FAILED",date:item.target_date,detail:data}),{status:502,headers:H});
 }

 await admin.from("source_backfill_queue").update({status:"DONE",finished_at:new Date().toISOString(),last_error:null}).eq("id",item.id);
 return new Response(JSON.stringify({ok:true,status:"DONE",date:item.target_date,detail:data}),{headers:H});
});
