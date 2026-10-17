import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const H={"Content-Type":"application/json","Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS"};
const uuid=(v:unknown)=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const reply=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:H});
const count=(v:unknown)=>{const n=Number(v??0);if(!Number.isSafeInteger(n)||n<0)throw Error('Invalid source count');return n};
const writers=['OWNER','ADMIN','ANALYST','MEMBER'];

Deno.serve(async(req:Request)=>{
 if(req.method==='OPTIONS')return reply({ok:true});
 if(req.method!=='POST')return reply({error:'POST required'},405);
 const auth=req.headers.get('Authorization')||'';if(!auth)return reply({error:'Unauthorized'},401);
 let admin:any=null,orgId:string|null=null,leadId='',runId:string|null=null;
 try{
  const url=Deno.env.get('SUPABASE_URL')!,anon=Deno.env.get('SUPABASE_ANON_KEY')!,service=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const uc=createClient(url,anon,{global:{headers:{Authorization:auth}}});admin=createClient(url,service);
  const session=await uc.auth.getUser(),user=session.data?.user;if(session.error||!user)return reply({error:'Unauthorized'},401);
  const b=await req.json().catch(()=>null);
  if(!b||typeof b!=='object'||Array.isArray(b)||!uuid(b.lead_id)||!uuid(b.company_id))return reply({error:'Valid lead_id and company_id required'},400);
  leadId=b.lead_id;const companyId=b.company_id;
  const profile=await admin.from('profiles').select('active_organization_id').eq('id',user.id).maybeSingle();
  if(profile.error)throw Error('Profile read failed');orgId=profile.data?.active_organization_id;
  if(!orgId)return reply({error:'No active organization'},409);
  const member=await admin.from('organization_members').select('role,status').eq('organization_id',orgId).eq('user_id',user.id).maybeSingle();
  if(member.error)throw Error('Membership read failed');
  if(member.data?.status!=='ACTIVE'||!writers.includes(member.data.role))return reply({error:'Operator access required'},403);
  const [loadedLead,loadedCompany]=await Promise.all([
   admin.from('leads').select('id,name').eq('id',leadId).eq('organization_id',orgId).maybeSingle(),
   admin.from('companies').select('id,cnpj,legal_name,trade_name').eq('id',companyId).eq('organization_id',orgId).maybeSingle()
  ]);
  if(loadedLead.error||loadedCompany.error)throw Error('Company context read failed');
  const lead=loadedLead.data,company=loadedCompany.data;
  if(!lead||!company)return reply({error:'Lead or company not found'},404);
  async function currentLink(){
   const link=await admin.from('lead_company_links').select('id,status').eq('organization_id',orgId).eq('lead_id',leadId).eq('company_id',companyId).maybeSingle();
   if(link.error)throw Error('Attribution read failed');
   return link.data&&!['REJECTED','CONTRADICTED'].includes(link.data.status);
  }
  if(!await currentLink())return reply({error:'Current company attribution requires review'},409);
  const sourceRead=await admin.from('source_registry').select('key,name,connection_status,action_url');
  if(sourceRead.error)throw Error('Source catalog read failed');
  const sourceMap=new Map<string,any>((sourceRead.data||[]).map((s:any)=>[s.key,s]));
  const defs=[
   {key:'financial_filings',title:'Central de Balanços / SPED',source:'central_balancos_sped'},
   {key:'bndes_financing',title:'Financiamentos BNDES',source:'bndes_financing'},
   {key:'public_contracts',title:'Contratos públicos PNCP',source:'pncp'},
   {key:'federal_transparency',title:'Portal da Transparência Federal',source:'portal_transparencia'},
   {key:'cvm',title:'Cadastro CVM',source:'cvm'},
   {key:'cvm_ipe',title:'Documentos IPE/CVM',source:'cvm_ipe'},
   {key:'signals',title:'Recalcular sinais consultivos',source:null}
  ];
  const run=await admin.from('research_runs').insert({organization_id:orgId,lead_id:leadId,strategy:'EMPRESARIO',objective:'Pesquisa profunda da empresa '+String(company.legal_name||company.cnpj||companyId),status:'RUNNING',steps:defs,started_at:new Date().toISOString(),created_by:user.id}).select('id').single();
  if(run.error||!run.data)throw Error('Run persistence failed');runId=run.data.id;
  const plan=await admin.from('research_steps').insert(defs.map((d,i)=>({organization_id:orgId,research_run_id:runId,step_key:d.key,step_order:i+1,title:d.title,source_key:d.source,status:'PENDING'})));
  if(plan.error)throw Error('Plan persistence failed');
  const deadline=Date.now()+120000;
  async function setStep(key:string,status:string,summary?:string,error?:string,metadata:any={}){
   const patch:any={status,metadata},now=new Date().toISOString();
   if(summary!==undefined)patch.result_summary=summary;if(error!==undefined)patch.error_summary=error;
   if(status==='RUNNING')patch.started_at=now;
   if(['COMPLETED','PARTIAL','BLOCKED','FAILED','SKIPPED'].includes(status))patch.finished_at=now;
   const saved=await admin.from('research_steps').update(patch).eq('organization_id',orgId).eq('research_run_id',runId).eq('step_key',key).select('id').maybeSingle();
   if(saved.error||!saved.data)throw Error('Step persistence failed');
  }
  async function callFn(fn:string,payload:any){
   const remaining=deadline-Date.now();if(remaining<=0)throw Error('Research round deadline');
   const resp=await fetch(url+'/functions/v1/'+fn,{method:'POST',headers:{Authorization:auth,'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(Math.max(1,Math.min(30000,remaining)))});
   let data:any;try{data=await resp.json()}catch{throw Error('Invalid source response')}
   if(!data||typeof data!=='object'||Array.isArray(data))throw Error('Invalid source response');
   return {resp,data};
  }
  const basePayload={lead_id:leadId,company_id:companyId,research_run_id:runId};
  let cvmFound:boolean|null=null;
  for(const d of defs.slice(0,6)){
   if(!await currentLink())throw Error('Company attribution changed during research');
   const s:any=d.source?sourceMap.get(d.source):null;
   if(d.source&&(!s||!['CONNECTED','CONNECTED_LIMITED'].includes(s.connection_status))){
    await setStep(d.key,'BLOCKED','Fonte '+(s?.name||d.source)+' ainda não está operacional para execução automática.',undefined,{source_status:s?.connection_status||'UNKNOWN',action_url:s?.action_url||null});continue;
   }
   if(Date.now()>=deadline){await setStep(d.key,'PARTIAL','Fonte não consultada: limite de duração da rodada atingido.',undefined,{attempted:false,complete:false});continue}
   if(d.key==='cvm_ipe'&&cvmFound===false){await setStep(d.key,'SKIPPED','CNPJ não consta no cadastro de companhias abertas consultado; IPE não é aplicável.');continue}
   await setStep(d.key,'RUNNING');
   try{
    if(d.key==='cvm_ipe'){
     const y=new Date().getUTCFullYear(),years=[y,y-1];let filings=0,successes=0,incomplete=false;const errors:string[]=[];
     for(const year of years){
      try{const one=await callFn('cvm-ipe-search',{...basePayload,years:[year]});
       if(one.resp.ok&&one.data.ok!==false&&one.data.status!=='BLOCKED'){filings+=count(one.data.filings_found);successes++;incomplete ||= one.data.complete===false||one.data.status==='PARTIAL'}
       else errors.push(year+': consulta não concluída (HTTP '+one.resp.status+').');
      }catch{errors.push(year+': fonte indisponível ou limite da rodada atingido.')}
     }
     if(!successes)await setStep(d.key,'FAILED',undefined,errors.join(' | '));
     else await setStep(d.key,filings>0&&!errors.length&&!incomplete?'COMPLETED':'PARTIAL',filings>0?filings+' documento(s) relevante(s) localizado(s) no IPE/CVM.':'Nenhum documento relevante localizado nos anos consultados; isso não prova ausência de evento corporativo.',errors.length?errors.join(' | '):undefined,{filings_found:filings,years,successful_years:successes,complete:successes===years.length&&!incomplete});
     continue;
    }
    const functions:Record<string,string>={financial_filings:'central-balancos-search',bndes_financing:'bndes-company-financing',public_contracts:'pncp-company-contracts',federal_transparency:'portal-transparencia-company',cvm:'cvm-company-check'};
    const {resp,data}=await callFn(functions[d.key],basePayload);
    if(!resp.ok||data.ok===false){await setStep(d.key,'FAILED',undefined,'Consulta não concluída (HTTP '+resp.status+').');continue}
    if(data.status==='BLOCKED'){await setStep(d.key,'BLOCKED','A fonte requer configuração ou revisão antes da consulta.',undefined,{complete:false});continue}
    const incomplete=data.complete===false||['PARTIAL','FAILED','REVIEW_REQUIRED'].includes(data.status);
    if(d.key==='financial_filings'){
     const n=count(data.documents_found);await setStep(d.key,n>0&&!incomplete?'COMPLETED':'PARTIAL',n>0?n+' documento(s) localizado(s) na Central de Balanços.':'Nenhum documento localizado; isso não prova ausência de demonstrações.',undefined,{documents_found:n,persisted:data.persisted||0,complete:!incomplete});
    }else if(d.key==='bndes_financing'){
     const n=count(data.operations_found);await setStep(d.key,n>0&&!incomplete?'COMPLETED':'PARTIAL',n>0?n+' operação(ões) BNDES localizada(s).':'Nenhuma operação localizada nas bases consultadas do BNDES.',undefined,{operations_found:n,complete:!incomplete});
    }else if(d.key==='public_contracts'){
     const n=count(data.contracts_found);await setStep(d.key,n>0&&!incomplete?'COMPLETED':'PARTIAL',n>0?n+' contrato(s) público(s) localizado(s).':'Nenhum contrato encontrado na cobertura PNCP indexada atual.',undefined,{contracts_found:n,index_coverage:data.index_coverage||null,complete:!incomplete});
    }else if(d.key==='federal_transparency'){
     const contracts=count(data.contracts_found),ceis=count(data.ceis_found),cnep=count(data.cnep_found),total=contracts+ceis+cnep;
     await setStep(d.key,total>0&&!incomplete?'COMPLETED':'PARTIAL',total>0?contracts+' contrato(s), '+ceis+' CEIS e '+cnep+' CNEP localizado(s).':'Nenhum registro localizado nas consultas federais executadas.',undefined,{contracts_found:contracts,ceis_found:ceis,cnep_found:cnep,complete:!incomplete});
    }else if(d.key==='cvm'){
     if(typeof data.found!=='boolean')throw Error('Invalid CVM context response');cvmFound=data.found;
     await setStep(d.key,incomplete?'PARTIAL':'COMPLETED',cvmFound?'Registro CVM localizado.':'CNPJ não localizado no cadastro de companhias abertas consultado.',undefined,{found:cvmFound,complete:!incomplete});
    }
   }catch{
    await setStep(d.key,'FAILED',undefined,'Fonte indisponível, resposta inválida ou limite da rodada atingido.');
   }
  }
  if(!await currentLink())throw Error('Company attribution changed during research');
  if(Date.now()>=deadline)await setStep('signals','PARTIAL','Sinais pendentes: limite de duração da rodada atingido.',undefined,{attempted:false});
  else{
   await setStep('signals','RUNNING');
   try{const sig=await callFn('derive-signals',{lead_id:leadId});
    if(sig.resp.ok&&sig.data.ok!==false)await setStep('signals','COMPLETED',String(sig.data.signals?.length||sig.data.count||0)+' sinal(is) consultivo(s) disponível(is) após esta pesquisa.');
    else await setStep('signals','FAILED',undefined,'Não foi possível recalcular os sinais consultivos.');
   }catch{await setStep('signals','FAILED',undefined,'Não foi possível recalcular os sinais consultivos.')}
  }
  const statusesRead=await admin.from('research_steps').select('status').eq('organization_id',orgId).eq('research_run_id',runId);
  if(statusesRead.error||!Array.isArray(statusesRead.data)||statusesRead.data.length!==defs.length)throw Error('Final plan read failed');
  const statuses=statusesRead.data.map((x:any)=>x.status),counters={failed:statuses.filter((s:string)=>s==='FAILED').length,blocked:statuses.filter((s:string)=>s==='BLOCKED').length,partial:statuses.filter((s:string)=>s==='PARTIAL').length,completed:statuses.filter((s:string)=>s==='COMPLETED').length,pending:statuses.filter((s:string)=>['PENDING','RUNNING'].includes(s)).length};
  const finalStatus=counters.failed||counters.blocked||counters.partial||counters.pending?'PARTIAL':'COMPLETED';
  const saved=await admin.from('research_runs').update({status:finalStatus,counters,finished_at:new Date().toISOString()}).eq('organization_id',orgId).eq('lead_id',leadId).eq('id',runId).select('id').maybeSingle();
  if(saved.error||!saved.data)throw Error('Final run persistence failed');
  return reply({ok:true,research_run_id:runId,status:finalStatus,counters,lead_id:leadId,company_id:companyId,company_name:company.legal_name||company.trade_name||company.cnpj});
 }catch{
  if(admin&&orgId&&runId){
   const failed=await admin.from('research_runs').update({status:'FAILED',counters:{fatal_error:'Company research context or persistence failed'},finished_at:new Date().toISOString()}).eq('organization_id',orgId).eq('lead_id',leadId).eq('id',runId).select('id').maybeSingle();
   if(failed.error||!failed.data)return reply({error:'Company research failed and its final state could not be persisted',research_run_id:runId,status:'FAILED'},500);
  }
  return reply({error:'Could not complete or persist company research',research_run_id:runId,status:'FAILED'},500);
 }
});
