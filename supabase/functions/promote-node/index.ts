import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { nodeLeadId, normalizeCompanyId } from '../_shared/company-context.ts';
const H={'Content-Type':'application/json','Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type','Access-Control-Allow-Methods':'POST, OPTIONS'};
const reply=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:H});
Deno.serve(async(req:Request)=>{
 if(req.method==='OPTIONS')return new Response('ok',{headers:H});
 if(req.method!=='POST')return reply({error:'POST required'},405);
 try{
 const auth=req.headers.get('Authorization')||'';
 const url=Deno.env.get('SUPABASE_URL')!;
 const uc=createClient(url,Deno.env.get('SUPABASE_ANON_KEY')!,{global:{headers:{Authorization:auth}}});
 const admin=createClient(url,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
 const {data:{user}}=await uc.auth.getUser();if(!user)return reply({error:'Unauthorized'},401);
 const b=await req.json();const type=String(b.entity_type||'').toUpperCase(),id=String(b.entity_id||''),originId=String(b.origin_lead_id||'');
 if(!['PERSON','COMPANY'].includes(type)||![id,originId].every(v=>/^[0-9a-f-]{36}$/i.test(v)))return reply({error:'Invalid node'},400);
 const {data:p}=await admin.from('profiles').select('active_organization_id').eq('id',user.id).single();const org=p?.active_organization_id;
 const {data:member}=await admin.from('organization_members').select('role,status').eq('organization_id',org).eq('user_id',user.id).maybeSingle();
 if(member?.status!=='ACTIVE'||member.role==='VIEWER')return reply({error:'Sem permissão para expandir este núcleo.'},403);
 const {data:origin}=await admin.from('leads').select('id').eq('id',originId).eq('organization_id',org).maybeSingle();
 if(!origin)return reply({error:'Origin lead not found'},404);
 const {data:relations,error:relError}=await admin.from('relationships').select('id,from_entity_type,from_entity_id,to_entity_type,to_entity_id').eq('lead_id',originId).eq('organization_id',org).neq('status','REJECTED');
 if(relError)throw relError;
 const relation=relations?.find(r=>(r.from_entity_type===type&&r.from_entity_id===id)||(r.to_entity_type===type&&r.to_entity_id===id));
 if(!relation)return reply({error:'Este nó não pertence às relações ativas do lead.'},404);
 const {data:entity,error:entityError}=await admin.from(type==='COMPANY'?'companies':'people').select('*').eq('organization_id',org).eq('id',id).maybeSingle();
 if(entityError)throw entityError;if(!entity)return reply({error:'Entity not found'},404);
 const deterministicId=await nodeLeadId(org,type,id);
 let {data:lead}=await admin.from('leads').select('*').eq('organization_id',org).eq('id',deterministicId).maybeSingle();
 // Recover company nuclei created by the previous implementation.
 if(!lead&&type==='COMPANY'){
  const {data:links,error}=await admin.from('lead_company_links').select('lead_id,leads!inner(*)').eq('organization_id',org).eq('company_id',id).neq('status','REJECTED').order('created_at');
  if(error)throw error;
  lead=links?.map((l:any)=>l.leads).find((l:any)=>l.kind==='COMPANY'&&l.origin_lead_id)||null;
 }
 let reused=Boolean(lead);
 if(!lead){
  const payload={id:deterministicId,organization_id:org,created_by:user.id,kind:type,name:type==='COMPANY'?(entity.legal_name||entity.trade_name||entity.cnpj):entity.display_name,city:entity.city,state:entity.state,segment:type==='COMPANY'?entity.cnae_description:null,initial_cnpj:type==='COMPANY'?normalizeCompanyId(entity.cnpj):null,reference_company:type==='COMPANY'?entity.legal_name:null,origin_lead_id:originId,origin_relationship_id:relation.id,origin_reason:type==='COMPANY'?'Empresa encontrada no ecossistema. Pesquisa própria por CNPJ.':'Pessoa encontrada no QSA. Identidade individual ainda exige desambiguação.',identity_status:'PENDING'};
  const inserted=await admin.from('leads').insert(payload).select('*').single();
  if(inserted.error?.code==='23505'){
   const raced=await admin.from('leads').select('*').eq('organization_id',org).eq('id',deterministicId).single();if(raced.error)throw raced.error;lead=raced.data;reused=true;
  }else{if(inserted.error)throw inserted.error;lead=inserted.data;}
 }
 if(type==='COMPANY'){
  if(!lead.initial_cnpj){const fixed=await admin.from('leads').update({initial_cnpj:normalizeCompanyId(entity.cnpj)}).eq('organization_id',org).eq('id',lead.id).is('initial_cnpj',null).select('*').maybeSingle();if(fixed.error)throw fixed.error;if(fixed.data)lead=fixed.data;}
  const {data:link,error}=await admin.from('lead_company_links').select('id').eq('organization_id',org).eq('lead_id',lead.id).eq('company_id',id).maybeSingle();if(error)throw error;
  if(!link){const added=await admin.from('lead_company_links').upsert({organization_id:org,lead_id:lead.id,company_id:id,role_label:'Lead representa esta empresa',status:'SUPPORTED'},{onConflict:'lead_id,company_id',ignoreDuplicates:true});if(added.error)throw added.error;}
 }
 // Opening an empty nucleus starts the same pipeline as a manually created lead.
 const {count,error:countError}=await admin.from('claims').select('id',{count:'exact',head:true}).eq('organization_id',org).eq('lead_id',lead.id);if(countError)throw countError;
 let research:any=null,researchError:string|null=null;
 if(!count){try{const r=await fetch(url+'/functions/v1/research-queue',{method:'POST',headers:{Authorization:auth,'Content-Type':'application/json'},body:JSON.stringify({action:'enqueue',lead_id:lead.id}),signal:AbortSignal.timeout(15000)});research=await r.json();if(!r.ok)researchError=research?.error||'Não foi possível iniciar a pesquisa.';}catch{researchError='A pesquisa não pôde ser iniciada. Use Iniciar investigação no dossiê.';}}
 return reply({ok:true,lead,reused,research,research_error:researchError});
 }catch(e){return reply({error:e instanceof Error?e.message:String((e as any)?.message||e)},500);}
});

