import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import {buildIntelligenceSnapshot,semanticSnapshot} from '../_shared/intelligence-history.ts';
const H={"Content-Type":"application/json","Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS"};
Deno.serve(async(req:Request)=>{
 const reply=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:H});
 if(req.method==='OPTIONS')return reply({ok:true});
 if(req.method!=='POST')return reply({error:'POST required'},405);
 const auth=req.headers.get('Authorization');if(!auth)return reply({error:'Unauthorized'},401);
 const url=Deno.env.get('SUPABASE_URL')!,admin=createClient(url,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
 const uc=createClient(url,Deno.env.get('SUPABASE_ANON_KEY')!,{global:{headers:{Authorization:auth}}});
 const {data:{user}}=await uc.auth.getUser();if(!user)return reply({error:'Unauthorized'},401);
 const {data:p}=await admin.from('profiles').select('active_organization_id').eq('id',user.id).maybeSingle();const org=p?.active_organization_id;
 if(!org)return reply({error:'No active organization'},409);
 const {data:m}=await admin.from('organization_members').select('role,status').eq('organization_id',org).eq('user_id',user.id).maybeSingle();
 if(m?.status!=='ACTIVE'||m.role==='VIEWER')return reply({error:'Write access required'},403);
 const b=await req.json().catch(()=>({})),leadId=String(b.lead_id||''),runId=b.research_run_id?String(b.research_run_id):null;
 if(!/^[0-9a-f-]{36}$/i.test(leadId)||(runId&&!/^[0-9a-f-]{36}$/i.test(runId)))return reply({error:'Valid lead_id required'},400);
 const {data:lead}=await admin.from('leads').select('id').eq('id',leadId).eq('organization_id',org).maybeSingle();if(!lead)return reply({error:'Lead not found'},404);
 if(runId){const {data:r}=await admin.from('research_runs').select('status,lead_id').eq('id',runId).eq('organization_id',org).maybeSingle();if(!r||r.lead_id!==leadId)return reply({error:'Research not found'},404);if(!['COMPLETED','PARTIAL'].includes(r.status))return reply({error:'Research not finished'},409);}
 try{
  const response=await fetch(url+'/functions/v1/get-dossier',{method:'POST',headers:{Authorization:auth,'Content-Type':'application/json'},body:JSON.stringify({lead_id:leadId,include_history:false}),signal:AbortSignal.timeout(20000)});
  if(!response.ok)return reply({error:'Could not capture dossier'},502);
  const d=await response.json();
  if((d.research_runs||[]).some((r:any)=>['PENDING','RUNNING'].includes(r.status)))return reply({error:'Wait for active research before capturing history'},409);
  if(runId&&d.research_runs?.[0]?.id!==runId)return reply({error:'Only the latest research can be captured from the current dossier'},409);
  // get-dossier must fail on incomplete database reads; never snapshot a query failure as disappearance.
  const payload=buildIntelligenceSnapshot(d),encoded=JSON.stringify(payload);
  if(new TextEncoder().encode(encoded).length>524288)return reply({error:'Snapshot exceeds safe size; history not truncated'},413);
  const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(semanticSnapshot(payload)));const fingerprint=Array.from(new Uint8Array(hash)).map(n=>n.toString(16).padStart(2,'0')).join('');
  const {data:last,error:lastError}=await admin.from('intelligence_snapshots').select('id,fingerprint').eq('organization_id',org).eq('lead_id',leadId).order('captured_at',{ascending:false}).limit(1).maybeSingle();if(lastError)throw lastError;
  if(!runId&&last?.fingerprint===fingerprint)return reply({ok:true,status:'UNCHANGED',snapshot_id:last.id});
  const {data:saved,error}=await admin.from('intelligence_snapshots').insert({organization_id:org,lead_id:leadId,research_run_id:runId,payload,fingerprint,created_by:user.id}).select('id').single();
  if(error?.code==='23505'&&runId){const {data:existing}=await admin.from('intelligence_snapshots').select('id').eq('organization_id',org).eq('lead_id',leadId).eq('research_run_id',runId).maybeSingle();if(existing)return reply({ok:true,status:'EXISTS',snapshot_id:existing.id});}
  if(error)throw error;
  return reply({ok:true,status:last?'CAPTURED':'BASELINE',snapshot_id:saved.id});
 }catch{return reply({error:'History capture failed; current dossier preserved'},502);}
});
