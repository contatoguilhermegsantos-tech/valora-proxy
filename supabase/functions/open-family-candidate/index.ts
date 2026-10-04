import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import {createClient} from 'jsr:@supabase/supabase-js@2';
import {nodeLeadId,normalizeCompanyId} from '../_shared/company-context.ts';
const H={'Content-Type':'application/json','Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type','Access-Control-Allow-Methods':'POST, OPTIONS'};
const reply=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:H});
const uuid=(value:unknown)=>/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value||''));
Deno.serve(async(req:Request)=>{
 if(req.method==='OPTIONS')return reply({ok:true});if(req.method!=='POST')return reply({error:'POST required'},405);
 const auth=req.headers.get('Authorization');if(!auth)return reply({error:'Unauthorized'},401);
 try{
  const url=Deno.env.get('SUPABASE_URL')!,uc=createClient(url,Deno.env.get('SUPABASE_ANON_KEY')!,{global:{headers:{Authorization:auth}}}),admin=createClient(url,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const {data:{user},error:authError}=await uc.auth.getUser();if(authError||!user)return reply({error:'Unauthorized'},401);
  const b=await req.json().catch(()=>({})),candidateId=String(b.candidate_id||'');
  if(!uuid(candidateId))return reply({error:'Valid candidate_id required'},400);
  const profile=await admin.from('profiles').select('active_organization_id').eq('id',user.id).maybeSingle();
  if(profile.error)throw new Error('Could not validate organization');const org=profile.data?.active_organization_id;if(!org)return reply({error:'No active organization'},409);
  const membership=await admin.from('organization_members').select('role,status').eq('organization_id',org).eq('user_id',user.id).maybeSingle();
  if(membership.error)throw new Error('Could not validate organization access');
  if(membership.data?.status!=='ACTIVE'||!['OWNER','ADMIN','ANALYST','MEMBER'].includes(membership.data?.role))return reply({error:'Write access required'},403);
  const result=await admin.from('candidate_entities').select('*').eq('id',candidateId).eq('organization_id',org).maybeSingle();
  if(result.error)throw new Error('Could not load candidate');const c=result.data;
  if(!c||!['FAMILY_CONTEXT_MATCH','FAMILY_NETWORK_COMPANY','FAMILY_NETWORK_PERSON'].includes(c.candidate_type))return reply({error:'Candidate not found'},404);
  if(c.candidate_type.startsWith('FAMILY_NETWORK_')&&c.metadata?.identity_confirmed!==false)return reply({error:'Network identity remains unresolved'},409);
  if(c.validation_status!=='UNVALIDATED'||c.confidence!=='LOW'||c.metadata?.kinship_confirmed!==false)return reply({error:'Candidate requires review; family attribution is not confirmed'},409);
  const type=String(b.entity_type||c.entity_type||'').toUpperCase(),md=c.metadata||{},cnpj=normalizeCompanyId(md.full_cnpj);
  if(!['PERSON','COMPANY'].includes(type)||!['PERSON','COMPANY'].includes(c.entity_type)||type==='PERSON'&&c.entity_type!=='PERSON')return reply({error:'Candidate entity type does not match'},409);
  if(type==='COMPANY'&&(!/^[A-Z0-9]{12}[0-9]{2}$/.test(cnpj)||!String(md.company_name||'').trim()))return reply({error:'A company candidate needs a full documented CNPJ and company name'},409);
  if(type==='PERSON'&&(md.match_basis!=='QSA_PERSON'||!String(md.person_name||'').trim()))return reply({error:'A person candidate needs its own QSA name; personal identity remains unresolved'},409);
  const origin=await admin.from('leads').select('id,kind').eq('id',c.lead_id).eq('organization_id',org).maybeSingle();
  if(origin.error)throw new Error('Could not validate origin');if(!origin.data)return reply({error:'Origin lead not found'},404);
  if(origin.data.kind!=='PERSON')return reply({error:'Family context must originate from a person lead'},409);
  if(!uuid(md.evidence_id))return reply({error:'Candidate has no documentary support'},409);
  const evidence=await admin.from('evidence').select('id,verification_status,source_registry_id').eq('id',md.evidence_id).eq('organization_id',org).eq('lead_id',c.lead_id).maybeSingle();
  if(evidence.error)throw new Error('Could not validate documentary support');
  if(evidence.data?.verification_status!=='VERIFIED'||!evidence.data.source_registry_id)return reply({error:'Candidate documentary support requires review'},409);
  const source=await admin.from('source_registry').select('id').eq('id',evidence.data.source_registry_id).maybeSingle();
  if(source.error)throw new Error('Could not validate source');if(!source.data)return reply({error:'Candidate source not found'},409);
  if(c.research_run_id){
   const run=await admin.from('research_runs').select('id').eq('id',c.research_run_id).eq('organization_id',org).eq('lead_id',c.lead_id).maybeSingle();
   if(run.error)throw new Error('Could not validate research context');if(!run.data)return reply({error:'Research context not found'},404);
  }
  const leadId=await nodeLeadId(org,type,type==='COMPANY'?'family-company:'+cnpj:'family-person:'+c.id);
  const opened=await admin.rpc('open_family_candidate',{p_org:org,p_user:user.id,p_candidate:c.id,p_entity_type:type,p_lead_id:leadId});
  if(opened.error||!opened.data?.lead)return reply({error:'Independent opening blocked by candidate, document or lead review'},409);
  const lead=opened.data.lead;
  if(lead.id!==leadId||lead.organization_id!==org||lead.kind!==type)return reply({error:'Independent lead context could not be confirmed'},500);
  const count=await admin.from('claims').select('id',{count:'exact',head:true}).eq('organization_id',org).eq('lead_id',lead.id);
  if(count.error)throw new Error('Could not check independent research');
  let research:any=null,researchError:string|null=null;
  if(!count.count){
   try{
    const queued=await fetch(url+'/functions/v1/research-queue',{method:'POST',headers:{Authorization:auth,'Content-Type':'application/json'},body:JSON.stringify({action:'enqueue',lead_id:lead.id}),signal:AbortSignal.timeout(15000)});
    research=await queued.json();if(!queued.ok)researchError=String(research?.error||'Não foi possível iniciar a pesquisa independente.');
   }catch{researchError='A pesquisa não pôde ser iniciada. Use Iniciar investigação no dossiê independente.'}
  }
  return reply({ok:true,lead,reused:opened.data.reused===true,research,research_error:researchError,kinship_confirmed:false});
 }catch{return reply({error:'Could not open independent research; no family relationship was confirmed'},500)}
});
