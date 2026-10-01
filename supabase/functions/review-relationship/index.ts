import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {createClient} from "jsr:@supabase/supabase-js@2";
const H={"Content-Type":"application/json","Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS"};
Deno.serve(async(req:Request)=>{
 const reply=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:H});
 if(req.method==='OPTIONS')return reply({ok:true});if(req.method!=='POST')return reply({error:'POST required'},405);
 const auth=req.headers.get('Authorization');if(!auth)return reply({error:'Unauthorized'},401);
 const url=Deno.env.get('SUPABASE_URL')!,admin=createClient(url,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
 const uc=createClient(url,Deno.env.get('SUPABASE_ANON_KEY')!,{global:{headers:{Authorization:auth}}});
 const {data:{user}}=await uc.auth.getUser();if(!user)return reply({error:'Unauthorized'},401);
 const {data:p}=await admin.from('profiles').select('active_organization_id').eq('id',user.id).maybeSingle();if(!p?.active_organization_id)return reply({error:'No active organization'},409);
 const {data:m}=await admin.from('organization_members').select('role,status').eq('organization_id',p.active_organization_id).eq('user_id',user.id).maybeSingle();if(m?.status!=='ACTIVE'||m.role==='VIEWER')return reply({error:'Write access required'},403);
 const b=await req.json().catch(()=>({})),id=String(b.relationship_id||''),action=String(b.action||''),reason=String(b.reason||'').trim();
 if(!/^[0-9a-f-]{36}$/i.test(id)||!['CONFIRM','REJECT'].includes(action)||reason.length<5||reason.length>2000)return reply({error:'Relationship, action and reason (5–2000 characters) required'},400);
 const {data:r}=await admin.from('relationships').select('id,lead_id').eq('id',id).eq('organization_id',p.active_organization_id).maybeSingle();if(!r)return reply({error:'Relationship not found'},404);
 const {data,error}=await admin.rpc('review_documented_relationship',{p_org:p.active_organization_id,p_user:user.id,p_relationship:id,p_action:action,p_reason:reason});
 if(error)return reply({error:'Não foi possível confirmar: vínculo rejeitado, contraditório, sem evidência válida ou identidade pendente.',code:error.code},409);
 return reply({ok:true,relationship:data,lead_id:r.lead_id});
});
