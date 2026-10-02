import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import {createClient} from 'jsr:@supabase/supabase-js@2';
import {fetchDfpFinancials,normalizeCnpj} from '../_shared/cvm-dfp.ts';
import {persistDfpFacts} from '../_shared/cvm-financial-persistence.ts';
const H={'Content-Type':'application/json','Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type','Access-Control-Allow-Methods':'POST, OPTIONS'};
const response=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:H});
Deno.serve(async(req:Request)=>{
 if(req.method==='OPTIONS')return new Response('ok',{headers:H});
 if(req.method!=='POST')return response({error:'POST required'},405);
 const auth=req.headers.get('Authorization');if(!auth)return response({error:'Unauthorized'},401);
 const base=Deno.env.get('SUPABASE_URL')!,anon=Deno.env.get('SUPABASE_ANON_KEY')!,service=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
 const client=createClient(base,anon,{global:{headers:{Authorization:auth}}}),admin=createClient(base,service);
 const userResult=await client.auth.getUser(),user=userResult.data?.user;
 if(userResult.error||!user)return response({error:'Unauthorized'},401);
 const body=await req.json().catch(()=>({})),leadId=String(body.lead_id||''),companyId=String(body.company_id||'');
 if(!leadId||!companyId)return response({error:'lead_id and company_id required'},400);
 const year=body.year===undefined?new Date().getUTCFullYear()-1:Number(body.year);
 if(!Number.isInteger(year)||year<2010||year>=new Date().getUTCFullYear())return response({error:'Choose a closed reference year from 2010 onward'},400);
 const profile=await admin.from('profiles').select('active_organization_id').eq('id',user.id).maybeSingle();
 if(profile.error)return response({error:'Could not validate organization'},500);
 const orgId=profile.data?.active_organization_id;if(!orgId)return response({error:'No active organization'},409);
 const membership=await admin.from('organization_members').select('role,status').eq('organization_id',orgId).eq('user_id',user.id).maybeSingle();
 if(membership.error)return response({error:'Could not validate organization access'},500);
 if(membership.data?.status!=='ACTIVE'||!['OWNER','ADMIN','ANALYST','MEMBER'].includes(membership.data?.role))return response({error:'Write access required'},403);
 const [lead,company,link,source]=await Promise.all([
  admin.from('leads').select('id').eq('id',leadId).eq('organization_id',orgId).maybeSingle(),
  admin.from('companies').select('id,cnpj').eq('id',companyId).eq('organization_id',orgId).maybeSingle(),
  admin.from('lead_company_links').select('status').eq('lead_id',leadId).eq('company_id',companyId).eq('organization_id',orgId).maybeSingle(),
  admin.from('source_registry').select('id,connection_status').eq('key','cvm_dfp').maybeSingle()
 ]);
 if([lead,company,link,source].some(r=>r.error))return response({error:'Could not validate company context'},500);
 if(!lead.data||!company.data)return response({error:'Lead or company not found'},404);
 if(!['SUPPORTED','VERIFIED'].includes(link.data?.status))return response({error:'Company attribution requires validation in this lead'},409);
 if(!source.data||!['CONNECTED','CONNECTED_LIMITED'].includes(source.data.connection_status))return response({error:'CVM DFP source unavailable'},409);
 if(body.research_run_id){
  const run=await admin.from('research_runs').select('id').eq('id',String(body.research_run_id)).eq('lead_id',leadId).eq('organization_id',orgId).maybeSingle();
  if(run.error)return response({error:'Could not validate research run'},500);
  if(!run.data)return response({error:'Research run not found in this lead'},404);
 }
 const cnpj=normalizeCnpj(company.data.cnpj);if(!/^[A-Z0-9]{12}\d{2}$/.test(cnpj))return response({error:'Company has no valid full CNPJ'},400);
 const started=Date.now();let data;
 try{data=await fetchDfpFinancials(cnpj,year)}catch{
  await admin.from('source_fetch_logs').insert({organization_id:orgId,research_run_id:body.research_run_id||null,source_registry_id:source.data.id,endpoint_reference:'CVM DFP consolidated annual ZIP (validated ranges)',success:false,result_status:'QUERY_FAILED',duration_ms:Date.now()-started,created_by:user.id});
  return response({error:'CVM DFP could not be read with validated limits; financial absence not determined',complete:false,cnpj,year},502);
 }
 try{
  const saved=await persistDfpFacts(admin,{organization_id:orgId,lead_id:leadId,company_id:companyId,source_registry_id:source.data.id,created_by:user.id},data);
  const log=await admin.from('source_fetch_logs').insert({organization_id:orgId,research_run_id:body.research_run_id||null,source_registry_id:source.data.id,endpoint_reference:'dados.cvm.gov.br/dados/CIA_ABERTA/DOC/DFP/DADOS/dfp_cia_aberta_{year}.zip: BPA/BPP/DRE con',success:true,http_status:206,result_status:saved.review_required?'REVIEW_REQUIRED':data.facts.length?'FINANCIAL_FACTS_FOUND':'NO_SELECTED_FINANCIAL_FACTS',duration_ms:Date.now()-started,created_by:user.id});
  if(log.error)throw new Error('Could not persist source result');
  return response({ok:true,complete:!saved.review_required,cnpj,year,scope:'CONSOLIDATED',facts_found:saved.claim_ids.length,extracted_count:data.facts.length,...saved,facts:data.facts,source_url:data.source_url,
   caveat:'Valores do último exercício encerrado solicitado, consolidados do emissor e suas controladas. Não representam posição atual, patrimônio pessoal ou capacidade comercial estimada. Uma conta não localizada permanece desconhecida.'});
 }catch{return response({error:'Could not persist verified financial results',complete:false},500)}
});
