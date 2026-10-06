import { resolveCompanyCnpj } from '../_shared/company-context.ts';
import {buildSourceRoutes,runIndependent} from '../_shared/source-router.ts';
import {ensureCompanyResearchLink,persistCompanyIdentitySupport} from '../_shared/company-research-link.ts';

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const H={"Content-Type":"application/json","Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, GET, OPTIONS"};
const cnpjNorm=(v:unknown)=>String(v??"").toUpperCase().replace(/[^A-Z0-9]/g,"");
const cnpjShape=(v:unknown)=>/^[A-Z0-9]{12}[0-9]{2}$/.test(cnpjNorm(v));
type Strategy="EMPRESARIO"|"AGRO"|"MEDICO"|"GENERICO";
type StepDef={key:string;title:string;source?:string};

const COMMON_COMPANY:StepDef[]=[
 {key:"name_discovery",title:"Descobrir empresas e CNPJs pelo nome do lead",source:"base_empresarial_rfb"},
 {key:"cnpj_qsa",title:"Consultar cadastro empresarial e quadro societário",source:"brasilapi_cnpj"},
 {key:"financial_filings",title:"Buscar demonstrações e atos societários na Central de Balanços",source:"central_balancos_sped"},
 {key:"municipal_gazettes",title:"Buscar menções em Diários Oficiais municipais",source:"querido_diario"},
 {key:"bndes_financing",title:"Verificar operações de financiamento no BNDES",source:"bndes_financing"},
 {key:"public_contracts",title:"Verificar contratos públicos na cobertura PNCP",source:"pncp"},
 {key:"federal_transparency",title:"Consultar contratos e registros administrativos federais",source:"portal_transparencia"}
];

const COMMON_FAMILY:StepDef[]=[
 {key:'surname_candidates',title:'Buscar pistas por sobrenome, município e segmento',source:'base_empresarial_rfb'},
 {key:'family_validation',title:'Validar parentesco por documentos independentes'}
];

const STRATEGIES:Record<Strategy,StepDef[]>={
 EMPRESARIO:[
  {key:"identity",title:"Validar identidade e contexto inicial"},...COMMON_COMPANY,...COMMON_FAMILY,
 {key:"cvm",title:"Verificar cadastro em companhias abertas",source:"cvm"},
  {key:"financial_statements",title:"Ler valores documentados no DFP anual consolidado",source:"cvm_dfp"},
  {key:"cvm_ipe",title:"Buscar documentos e eventos corporativos no IPE/CVM",source:"cvm_ipe"},
  {key:"corporate_history",title:"Investigar histórico societário e arquivamentos",source:"jucesp"},
  {key:"mna",title:"Verificar M&A / atos de concentração",source:"cade"},
  {key:"web_context",title:"Buscar contexto corporativo complementar",source:"web_search"},
  {key:"events",title:"Consolidar eventos econômicos e questões investigativas"},
  {key:"signals",title:"Derivar sinais consultivos somente a partir de evidências"}
 ],
 AGRO:[
  {key:"identity",title:"Validar identidade, município e atividade agro"},...COMMON_COMPANY,...COMMON_FAMILY,
  {key:"cvm",title:"Verificar cadastro em companhias abertas",source:"cvm"},
  {key:"financial_statements",title:"Ler valores documentados no DFP anual consolidado",source:"cvm_dfp"},
  {key:"cvm_ipe",title:"Buscar documentos e eventos corporativos no IPE/CVM",source:"cvm_ipe"},
  {key:"corporate_history",title:"Investigar histórico societário",source:"jucesp"},
  {key:"web_context",title:"Buscar contexto agro/corporativo complementar",source:"web_search"},
  {key:"events",title:"Consolidar eventos econômicos e questões investigativas"},
  {key:"signals",title:"Derivar sinais consultivos somente a partir de evidências"}
 ],
 MEDICO:[
  {key:"identity",title:"Validar identidade profissional e empresarial"},...COMMON_COMPANY,...COMMON_FAMILY,
 {key:"cvm",title:"Verificar eventual cadastro em companhias abertas",source:"cvm"},
  {key:"financial_statements",title:"Ler valores documentados no DFP anual consolidado",source:"cvm_dfp"},
  {key:"cvm_ipe",title:"Buscar documentos e eventos corporativos no IPE/CVM",source:"cvm_ipe"},
  {key:"societies",title:"Expandir sociedades, sócios e administradores"},
  {key:"web_context",title:"Buscar contexto corporativo/profissional complementar",source:"web_search"},
  {key:"events",title:"Investigar eventos empresariais relevantes"},
  {key:"signals",title:"Derivar sinais consultivos somente a partir de evidências"}
 ],
 GENERICO:[
  {key:"identity",title:"Validar identidade"},...COMMON_COMPANY,...COMMON_FAMILY,
 {key:"cvm",title:"Verificar cadastro em companhias abertas",source:"cvm"},
  {key:"financial_statements",title:"Ler valores documentados no DFP anual consolidado",source:"cvm_dfp"},
  {key:"cvm_ipe",title:"Buscar documentos e eventos corporativos no IPE/CVM",source:"cvm_ipe"},
  {key:"relationships",title:"Expandir relações empresariais existentes"},
  {key:"web_context",title:"Buscar contexto público complementar",source:"web_search"},
  {key:"events",title:"Consolidar eventos e pendências"},
  {key:"signals",title:"Derivar sinais consultivos somente a partir de evidências"}
 ]
};

async function callFn(url:string,auth:string,name:string,body:any){
 const resp=await fetch(url+"/functions/v1/"+name,{method:"POST",headers:{Authorization:auth,"Content-Type":"application/json"},body:JSON.stringify(body),signal:AbortSignal.timeout(90000)});
 const text=await resp.text();
 let data:any=null;
 try{data=text?JSON.parse(text):null}catch{data={error:"Invalid JSON from "+name,raw:text.slice(0,300)}}
 return {resp,data};
}

Deno.serve(async(req:Request)=>{
 if(req.method==="OPTIONS")return new Response("ok",{headers:H});
 if(req.method!=="POST")return new Response(JSON.stringify({error:"POST required"}),{status:405,headers:H});
 const auth=req.headers.get("Authorization");
 if(!auth)return new Response(JSON.stringify({error:"Unauthorized"}),{status:401,headers:H});

 const url=Deno.env.get("SUPABASE_URL")!,anon=Deno.env.get("SUPABASE_ANON_KEY")!,service=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
 const uc=createClient(url,anon,{global:{headers:{Authorization:auth}}}),admin=createClient(url,service);
 const {data:{user}}=await uc.auth.getUser();
 if(!user)return new Response(JSON.stringify({error:"Unauthorized"}),{status:401,headers:H});

 const b=await req.json().catch(()=>({}));
 const leadId=String(b.lead_id||"");
 const strategy=String(b.strategy||"GENERICO") as Strategy;
 const requestCnpj=cnpjNorm(b.cnpj);
 if(!leadId||!(strategy in STRATEGIES))return new Response(JSON.stringify({error:"lead_id/strategy invalid"}),{status:400,headers:H});

 const {data:p}=await admin.from("profiles").select("active_organization_id").eq("id",user.id).maybeSingle();
 const orgId=p?.active_organization_id;
 if(!orgId)return new Response(JSON.stringify({error:"No active organization"}),{status:409,headers:H});
 const {data:membership}=await admin.from("organization_members").select("role,status").eq("organization_id",orgId).eq("user_id",user.id).maybeSingle();
 if(membership?.status!=="ACTIVE")return new Response(JSON.stringify({error:"No organization access"}),{status:403,headers:H});
  if(!['OWNER','ADMIN','ANALYST','MEMBER'].includes(membership.role))return new Response(JSON.stringify({error:"Operator access required"}),{status:403,headers:H});
 const {data:lead}=await admin.from("leads").select("*").eq("id",leadId).eq("organization_id",orgId).maybeSingle();
 if(!lead)return new Response(JSON.stringify({error:"Lead not found"}),{status:404,headers:H});
 const jobId=b.research_job_id?String(b.research_job_id):null;
 if(jobId){
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(jobId))return new Response(JSON.stringify({error:'Valid research job required'}),{status:400,headers:H});
  const job=await admin.from('research_job_queue').select('id,status,job_type').eq('id',jobId).eq('organization_id',orgId).eq('lead_id',leadId).eq('requested_by',user.id).maybeSingle();
  if(job.error)return new Response(JSON.stringify({error:'Could not validate research job'}),{status:500,headers:H});
  if(!job.data||job.data.status!=='RUNNING'||job.data.job_type!=='LEAD_RESEARCH')return new Response(JSON.stringify({error:'Running research job does not match this lead'}),{status:409,headers:H});
 }
 const {data:contextLinks,error:contextError}=lead.kind==='COMPANY'?await admin.from('lead_company_links').select('status,companies(cnpj)').eq('organization_id',orgId).eq('lead_id',lead.id):{data:[],error:null};
 if(contextError)return new Response(JSON.stringify({error:contextError.message}),{status:500,headers:H});
 let resolvedCnpj='';try{resolvedCnpj=resolveCompanyCnpj(lead,b.cnpj,contextLinks||[])}catch(e){return new Response(JSON.stringify({error:String((e as Error).message)}),{status:409,headers:H})}
 const cnpj=resolvedCnpj;

 const {data:sources,error:sourcesError}=await admin.from("source_registry").select("key,name,connection_status,action_url,limitations");
 if(sourcesError)return new Response(JSON.stringify({error:'Could not load source routing catalog'}),{status:500,headers:H});
 const sourceMap=new Map((sources||[]).map((s:any)=>[s.key,s]));
 const {data:run,error:runError}=await admin.from("research_runs").insert({
  organization_id:orgId,lead_id:leadId,strategy,objective:b.objective||"Qualificação profunda baseada em evidências",
  status:"RUNNING",started_at:new Date().toISOString(),created_by:user.id
 }).select("id").single();
 if(runError)return new Response(JSON.stringify({error:runError.message}),{status:500,headers:H});

 const defs=STRATEGIES[strategy];
 const routes=buildSourceRoutes(sources||[],{kind:lead.kind,companyResolved:cnpjShape(cnpj),braveConfigured:!!Deno.env.get('BRAVE_SEARCH_API_KEY'),portalConfigured:!!Deno.env.get('PORTAL_TRANSPARENCIA_API_TOKEN')});
 const {error:insertStepsError}=await admin.from("research_steps").insert(defs.map((s,i)=>{
  const src:any=s.source?sourceMap.get(s.source):null;
  const route=routes.find(r=>r.steps.includes(s.key));
  return {organization_id:orgId,research_run_id:run.id,step_key:s.key,step_order:i+1,title:s.title,source_key:s.source||null,status:"PENDING",action_url:src?.action_url||null,metadata:{...(src?{source_status:src.connection_status,limitations:src.limitations}:{}),...(route?{source_route:route}: {})}};
 }));
 if(insertStepsError){await admin.from('research_runs').update({status:'FAILED',finished_at:new Date().toISOString(),counters:{fatal_error:'Could not persist research plan'}}).eq('id',run.id);return new Response(JSON.stringify({error:'Could not persist research plan',research_run_id:run.id}),{status:500,headers:H})}

 const jobProgress=async(stage:string,message:string,status='RUNNING')=>{
  if(!jobId)return;
  const saved=await admin.from('research_job_queue').update({progress:{stage,message,research_run_id:run.id,research_status:status},updated_at:new Date().toISOString()}).eq('id',jobId).eq('organization_id',orgId).eq('lead_id',leadId).eq('requested_by',user.id).eq('status','RUNNING').select('id').maybeSingle();
  if(saved.error||!saved.data)throw Error('Could not bind research progress to its running job');
 };
 try{await jobProgress('PLAN_READY','Plano criado; iniciando a pesquisa.')}catch{await admin.from('research_runs').update({status:'FAILED',finished_at:new Date().toISOString(),counters:{fatal_error:'Could not bind running research job'}}).eq('id',run.id).eq('organization_id',orgId);return new Response(JSON.stringify({error:'Could not bind running research job',research_run_id:run.id}),{status:500,headers:H})}

 const setStep=async(key:string,status:string,summary?:string,error?:string,extra:any={})=>{
  const route=routes.find(r=>r.steps.includes(key));
  const patch:any={status,result_summary:summary||null,error_summary:error||null,metadata:{...(route?{source_route:route}:{}),...extra}};
  if(key==='surname_candidates'&&['base_empresarial_rfb','minha_receita_rfb'].includes(extra.provider)){
   const actualSource:any=sourceMap.get(extra.provider);patch.source_key=extra.provider;patch.action_url=actualSource?.action_url||null;
  }
  if(status==="RUNNING")patch.started_at=new Date().toISOString();
  if(["COMPLETED","PARTIAL","BLOCKED","FAILED","SKIPPED"].includes(status))patch.finished_at=new Date().toISOString();
  const {error:stepError}=await admin.from("research_steps").update(patch).eq("research_run_id",run.id).eq("step_key",key);
  if(stepError)throw new Error('Could not persist research progress: '+key);
  await jobProgress(key,summary||defs.find(s=>s.key===key)?.title||'Pesquisa em andamento.');
 };

 try{
  await setStep("identity","RUNNING","Lead carregado; iniciando resolução de identidade.",undefined,{identity_status:lead.identity_status});
  let companyId:string|null=null,cnpjResult:any=null;
  let nameCandidates:any[]=[];
  let identityStatus=String(lead.identity_status||"PENDING");
  let supportedClusterCompanies:any[]=[];

  if(lead.kind==='COMPANY'&&cnpjShape(cnpj)){await setStep('name_discovery','SKIPPED','CNPJ do núcleo já informado; pesquisa cadastral pelo identificador exato.');}
  if(lead.kind==='COMPANY'&&!cnpjShape(cnpj)){
   await setStep('name_discovery','RUNNING','Buscando razão social e nome fantasia; o CNPJ exigirá confirmação.');
   const discovery=await callFn(url,auth,'company-name-discovery',{lead_id:leadId,research_run_id:run.id});
   if(discovery.resp.ok){nameCandidates=(Array.isArray(discovery.data?.candidates)?discovery.data.candidates:[]).filter((x:any)=>x.validation_status!=='REJECTED');await setStep('name_discovery',discovery.data?.status==='BLOCKED'?'BLOCKED':discovery.data?.complete===true?'COMPLETED':'PARTIAL',nameCandidates.length?`${nameCandidates.length} candidato(s) de razão social/nome fantasia. Confirme o CNPJ do estabelecimento correto para liberar a pesquisa documental.`:'Nenhum candidato ativo no recorte consultado; a resposta não comprova inexistência da empresa.',undefined,{candidates_found:nameCandidates.length,candidate_type:'RFB_COMPANY_NAME_MATCH',confirmation_required:true,complete:discovery.data?.complete===true,search_lineage:discovery.data?.search_lineage||null})}
   else await setStep('name_discovery','FAILED',undefined,discovery.data?.error||('HTTP '+discovery.resp.status),{candidate_type:'RFB_COMPANY_NAME_MATCH',confirmation_required:true,complete:false});
  }
  if(lead.kind!=="COMPANY"&&defs.some(s=>s.key==="name_discovery")){
    await setStep("name_discovery","RUNNING");
    const {resp,data}=await callFn(url,auth,"name-company-discovery",{lead_id:leadId,research_run_id:run.id});
    if(resp.ok){
      nameCandidates=(Array.isArray(data?.candidates)?data.candidates:[]).filter((x:any)=>x?.validation_status!=="REJECTED");
      const high=nameCandidates.filter((x:any)=>x.confidence==="HIGH").length;
      const medium=nameCandidates.filter((x:any)=>x.confidence==="MEDIUM").length;
      const n=nameCandidates.length;
      await setStep(
        "name_discovery",
        n>0&&data?.complete!==false?"COMPLETED":"PARTIAL",
        n>0
          ? n+" candidato(s) societário(s) ativo(s) encontrado(s) pelo nome ("+high+" com alta aderência contextual, "+medium+" com aderência média)."
          : "Nenhum candidato societário ativo localizado pelo nome nesta fonte; candidatos rejeitados anteriormente não são reabertos automaticamente.",
        undefined,
        {candidates_found:n,high_confidence:high,medium_confidence:medium,search_lineage:data?.search_lineage||null,complete:data?.complete!==false}
      );
    }else{
      await setStep("name_discovery","FAILED",undefined,data?.error||("HTTP "+resp.status));
    }
  }

  if(lead.kind==="PERSON"){
    const identity=await callFn(url,auth,"identity-resolution",{lead_id:leadId,research_run_id:run.id,run_discovery:false,run_fallback:true});
    if(identity.resp.ok){
      const st=String(identity.data?.lead_status||"PENDING");
      identityStatus=st;
      await setStep(
        "identity",
        ["VERIFIED","SUPPORTED"].includes(st)?"COMPLETED":"PARTIAL",
        st==="VERIFIED"
          ?"Identidade/vínculo confirmado explicitamente pelo usuário."
          :st==="SUPPORTED"
            ?"Identidade suportada por sinais contextuais; ainda não equivale a confirmação humana."
            :st==="CAUTION"
              ?"Há candidatos ou ambiguidade que exigem validação humana."
              :"Não houve evidência suficiente para resolver a identidade.",
        undefined,
        {lead_status:st,candidates_assessed:identity.data?.candidates_assessed||0,ambiguity:Boolean(identity.data?.ambiguity)}
      );
    }else{
      await setStep("identity","FAILED",undefined,identity.data?.error||("HTTP "+identity.resp.status));
    }
  }else{
    await setStep("identity","PARTIAL","Lead empresarial carregado; a identidade jurídica será ancorada ao CNPJ quando disponível.");
  }

  if(cnpjShape(cnpj)){
   await setStep("cnpj_qsa","RUNNING");
   const {resp,data}=await callFn(url,auth,"cnpj-enrich",{lead_id:leadId,cnpj});
   cnpjResult=data;
   if(resp.ok&&data?.status==="REVIEW_REQUIRED"){
    await setStep("cnpj_qsa","BLOCKED","A evidência cadastral foi revisada e não está verificada. Nenhum fato ou vínculo foi restaurado automaticamente.",undefined,{evidence_id:data.evidence_id});
   }else if(resp.ok&&data?.company_id){
    const attributed=await ensureCompanyResearchLink(admin,lead,orgId,data.company_id,cnpj,data.evidence_id);
    companyId=attributed?data.company_id:null;
    if(!attributed){await setStep('cnpj_qsa','BLOCKED','Cadastro consultado, mas atribuição da empresa a este núcleo exige revisão. Nenhum vínculo rejeitado ou identidade pessoal foi confirmado.',undefined,{company_id:data.company_id,evidence_id:data.evidence_id});}
    else{
    await setStep("cnpj_qsa","COMPLETED","Cadastro consultado via "+(data.provider==='base_empresarial_rfb'?'Base Empresarial (fallback)':'BrasilAPI')+". "+(data.relationship_ids?.length||0)+" relação(ões) de QSA persistida(s) com evidência.",undefined,{company_id:companyId,evidence_id:data.evidence_id,provider:data.provider||'brasilapi_cnpj'});
    if(lead.kind==="COMPANY"){
      identityStatus=await persistCompanyIdentitySupport(admin,leadId,orgId);
      await setStep("identity","COMPLETED",identityStatus==='VERIFIED'?"Confirmação existente da identidade jurídica preservada; cadastro empresarial consultado.":"Identidade jurídica suportada pelo CNPJ consultado e cadastro empresarial persistido.",undefined,{company_id:companyId,cnpj,identity_status:identityStatus});
    }
    }
   }else await setStep("cnpj_qsa","FAILED",undefined,data?.error||("HTTP "+resp.status));
  }else if(lead.kind==="PERSON"&&identityStatus==="SUPPORTED"){
   await setStep("cnpj_qsa","RUNNING","Identidade suportada; enriquecendo o grupo de empresas sem eleger uma empresa primária.");
   const cluster=await callFn(url,auth,"enrich-supported-identity-cluster",{lead_id:leadId,research_run_id:run.id});
   if(cluster.resp.ok){
    supportedClusterCompanies=Array.isArray(cluster.data?.companies)?cluster.data.companies:[];
    const n=supportedClusterCompanies.length;
    await setStep("cnpj_qsa",n>0?"COMPLETED":"PARTIAL",
      n>0?n+" empresa(s) do grupo de identidade suportado foram enriquecidas e adicionadas ao ecossistema como vínculos indicativos. Nenhuma foi escolhida arbitrariamente como empresa principal.":"A identidade está suportada, mas nenhuma empresa candidata pôde ser enriquecida nesta execução.",
      undefined,{supported_company_count:n,eligible_candidates:cluster.data?.eligible_candidates||0,errors:cluster.data?.errors||[]});
   }else{
    await setStep("cnpj_qsa","FAILED",undefined,cluster.data?.error||("HTTP "+cluster.resp.status));
   }
  }else await setStep(
    "cnpj_qsa",
    "BLOCKED",
    nameCandidates.length
      ? "Há candidato(s) empresariais, mas a identidade ainda exige confirmação ou suporte contextual adicional antes do enriquecimento profundo."
      : "CNPJ ainda não disponível; a etapa não foi simulada."
  );

  if(defs.some(s=>s.key==='surname_candidates')){
   if(lead.kind!=='PERSON')await setStep('surname_candidates','SKIPPED','Busca por sobrenome é destinada a núcleos de pessoas; nenhum parentesco é inferido para uma empresa.');
   else{
    await setStep('surname_candidates','RUNNING','Consultando empresas do município e atividade; cruzando sobrenome em razão social e QSA público.');
    const {resp,data}=await callFn(url,auth,'family-cluster-discovery',{lead_id:leadId,research_run_id:run.id});
    if(resp.ok){
     const state=data?.status==='BLOCKED'?'BLOCKED':data?.status==='FAILED'?'FAILED':data?.complete===true?'COMPLETED':'PARTIAL';
     const provider=data?.provider==='minha_receita_rfb'||data?.search_lineage?.business_provider==='MINHA_RECEITA'?'minha_receita_rfb':'base_empresarial_rfb';
     await setStep('surname_candidates',state,data?.note||((data?.candidates_found||0)+' pista(s) por sobrenome e contexto empresarial. '+(data?.complete?'Recorte consultado encerrado; ausência de pistas não prova ausência de grupo familiar.':'Consulta parcial; continue a busca para ampliar o recorte.')),undefined,{provider,candidates_found:data?.candidates_found||0,complete:data?.complete===true,search_lineage:data?.search_lineage||null,pivot_id:data?.pivot?.id||null});
     if(Number(data?.candidates_found)>0&&state!=='BLOCKED'&&state!=='FAILED'){
      try{
       const expanded=await callFn(url,auth,'family-network-discovery',{lead_id:leadId,research_run_id:run.id,action:'expand'});
       const network=expanded.data?.network;
       await setStep('surname_candidates','PARTIAL',expanded.resp.ok&&network
        ? `Mapa iniciado com ${network.counts?.companies||0} CNPJ(s) e ${network.counts?.people||0} ocorrência(s) nominal(is) em QSA. As conexões são documentadas ou hipóteses explícitas; identidade e parentesco permanecem pendentes.`
        : 'Pistas do pivô preservadas; a expansão do mapa não pôde ser concluída nesta rodada. Continue na seção Relações.',undefined,{provider,candidates_found:data.candidates_found,complete:false,search_lineage:data.search_lineage||null,pivot_id:data.pivot?.id||null,network_pivot_id:expanded.data?.pivot?.id||null,network_continuation:expanded.data?.continuation===true,network_counts:network?.counts||null});
      }catch{await setStep('surname_candidates','PARTIAL','Pistas do pivô preservadas; a expansão do mapa exige retomada na seção Relações.',undefined,{provider,candidates_found:data.candidates_found,complete:false,pivot_id:data.pivot?.id||null})}
     }
    }else await setStep('surname_candidates','FAILED',undefined,data?.error||('HTTP '+resp.status));
   }
  }

  if(defs.some(s=>s.key==="municipal_gazettes")){
   await setStep("municipal_gazettes","RUNNING");
   const {resp,data}=await callFn(url,auth,"querido-diario-search",{lead_id:leadId,max_results:10,research_run_id:run.id});
   const municipalMeta={territory_id:data?.territory_id||null,mentions_found:Number(data?.mentions_found||0),terms_searched:data?.terms_searched||[],complete:data?.complete===true,source_result:data?.status||null,wrapper_http_status:resp.status,upstream_http_status:data?.upstream_http_status??null,source_error:data?.source_error||null,source_errors:data?.source_errors||[],source_attempts:data?.source_attempts||[],queries_completed:data?.queries_completed||0,queries_failed:data?.queries_failed||0,queries_skipped:data?.queries_skipped||0,retry_after_seconds:data?.retry_after_seconds??null,retry_not_before:data?.retry_not_before||null,truncated:data?.truncated===true};
   if(resp.ok){
    const found=Number(data?.mentions_found||0);
    await setStep("municipal_gazettes",data?.status==='BLOCKED'?'BLOCKED':found>0&&data?.complete===true?"COMPLETED":"PARTIAL",
      data?.note||(data?.status==="PARTIAL"?"Consulta incompleta; resultados parciais preservados. Não interpretar como ausência de menções.":found>0?found+" menção(ões) localizada(s) em Diários Oficiais municipais.":"Nenhuma menção encontrada na cobertura municipal consultada; isso não prova inexistência."),
      undefined,municipalMeta);
   }else await setStep("municipal_gazettes","FAILED",undefined,data?.error||data?.note||(data?.source_error?'Querido Diário: '+data.source_error+'. Consulta à fonte não concluída; não comprova ausência de menções.':"Falha ao executar consulta municipal (HTTP "+resp.status+"); resposta da fonte não confirmada."),municipalMeta);
  }


  if(companyId){
   routes.splice(0,routes.length,...buildSourceRoutes(sources||[],{kind:lead.kind,companyResolved:true,braveConfigured:!!Deno.env.get('BRAVE_SEARCH_API_KEY'),portalConfigured:!!Deno.env.get('PORTAL_TRANSPARENCIA_API_TOKEN')}));
   const connected=[
    ["financial_filings","central-balancos-search"],
    ["bndes_financing","bndes-company-financing"],
    ["public_contracts","pncp-company-contracts"],
    ["federal_transparency","portal-transparencia-company"],
    ["cvm","cvm-company-check"],
    ["cvm_ipe","cvm-ipe-search"],
    ["financial_statements","cvm-financial-statements"]
   ] as const;
   let cvmFound:boolean|null=null;

   const liveRoutes=buildSourceRoutes(sources||[],{kind:lead.kind,companyResolved:true,braveConfigured:!!Deno.env.get('BRAVE_SEARCH_API_KEY'),portalConfigured:!!Deno.env.get('PORTAL_TRANSPARENCIA_API_TOKEN')});
   const runConnected=async([step,defaultFn]:typeof connected[number])=>{
    const def=defs.find(s=>s.key===step);
    if(!def)return;
    const route=liveRoutes.find(r=>r.steps.includes(step));
    const fn=route?.selected||defaultFn;
    const configuredSource:any=def.source?sourceMap.get(def.source):null;
    if(!route?.selected){
      await setStep(step,"BLOCKED","Fonte "+(configuredSource?.name||def.source)+" ainda não está operacional para execução automática.",undefined,{source_status:configuredSource?.connection_status||"UNKNOWN",action_url:configuredSource?.action_url||null});
      return;
    }
    if(['cvm_ipe','financial_statements'].includes(step)&&cvmFound===false){
      await setStep(step,"SKIPPED","CNPJ não está no cadastro de companhias abertas consultado; fonte CVM documental não executada para este CNPJ.");
      return;
    }
    if(step==="cvm_ipe"){
      await setStep(step,"RUNNING");
      const y=new Date().getUTCFullYear();
      const checkedYears=[y,y-1];
      let filings=0,successes=0,allComplete=true;
      const errors:string[]=[];
      for(const year of checkedYears){
        const one=await callFn(url,auth,fn,{lead_id:leadId,company_id:companyId,research_run_id:run.id,years:[year]});
        if(one.resp.ok){filings+=Number(one.data?.filings_found||0);successes++;allComplete &&= one.data?.complete===true}
        else errors.push(year+": "+String(one.data?.error||("HTTP "+one.resp.status)));
      }
      if(successes===0){
        await setStep(step,"FAILED",undefined,errors.join(" | "));
      }else{
        const status=filings>0&&allComplete&&errors.length===0?"COMPLETED":"PARTIAL";
        const summary=filings>0
          ? filings+" documento(s)/evento(s) relevante(s) localizado(s) no índice oficial IPE/CVM nos anos "+checkedYears.join(" e ")+"."
          : "Nenhum documento relevante localizado no recorte IPE consultado nos anos "+checkedYears.join(" e ")+"; isso não prova ausência de evento corporativo.";
        await setStep(step,status,summary,errors.length?errors.join(" | "):undefined,{filings_found:filings,years:checkedYears,successful_years:successes});
      }
      return;
    }
    await setStep(step,"RUNNING");
    const {resp,data}=await callFn(url,auth,fn,{lead_id:leadId,company_id:companyId,research_run_id:run.id});
    if(!resp.ok){await setStep(step,resp.status===428?"BLOCKED":"FAILED",undefined,data?.error||("HTTP "+resp.status),{action_url:data?.setup_url||null});return}

    if(data?.status==='REVIEW_REQUIRED'){await setStep(step,'BLOCKED','Documento aguarda revisão; nenhum fato foi restaurado.');return}
    if(step==='financial_statements'){
      const n=Number(data?.facts_found||0),review=Number(data?.review_required||0);
      await setStep(step,n>0&&data?.complete===true?'COMPLETED':'PARTIAL',review?'Há revisão documental pendente; valores rejeitados ou contraditórios não foram restaurados.':n>0?n+' valor(es) do DFP '+data.year+' consolidado documentado(s), com período, escala, versão e conta oficial. Não representam posição financeira atual.':'Nenhuma conta selecionada localizada no DFP consolidado consultado; situação financeira permanece desconhecida.',undefined,{facts_found:n,year:data?.year,scope:data?.scope,review_required:review,complete:data?.complete===true});
    }
    if(step==="financial_filings"){
      const n=Number(data?.documents_found||0);
      await setStep(step,n>0&&!data?.truncated?"COMPLETED":"PARTIAL",
        n>0?n+" documento(s) localizado(s) na Central de Balanços; metadados, evidências e eventos foram persistidos.":"Nenhum documento localizado na Central de Balanços para este CNPJ; isso não prova ausência de demonstrações ou atos.",
        undefined,{documents_found:n,documents_processed:data?.documents_processed||0,persisted:data?.persisted||0,truncated:Boolean(data?.truncated)});
    }
    if(step==="bndes_financing"){
      const n=Number(data?.operations_found||0);
      await setStep(step,n>0&&data?.complete===true?"COMPLETED":"PARTIAL",n>0?n+" operação(ões) de financiamento BNDES localizada(s) e persistida(s) com evidência oficial.":"Nenhuma operação localizada nas bases consultadas do BNDES; isso não prova ausência de crédito por outras fontes.",undefined,{operations_found:n});
    }
    if(step==="public_contracts"){
      const n=Number(data?.contracts_found||0);
      await setStep(step,n>0?"COMPLETED":"PARTIAL",n>0?n+" contrato(s) público(s) encontrado(s) na cobertura indexada.":"Nenhum contrato encontrado na cobertura indexada atual. Isso não é tratado como prova de inexistência.",undefined,data||{});
    }
    if(step==="federal_transparency"){
      const contracts=Number(data?.contracts_found||0),ceis=Number(data?.ceis_found||0),cnep=Number(data?.cnep_found||0);
      const total=contracts+ceis+cnep;
      await setStep(step,total>0&&data?.complete===true?"COMPLETED":"PARTIAL",
        total>0?contracts+" contrato(s), "+ceis+" registro(s) CEIS e "+cnep+" registro(s) CNEP localizados na fonte federal.":"Nenhum registro localizado nas consultas federais executadas; isso não prova inexistência fora da cobertura consultada.",
        undefined,{contracts_found:contracts,ceis_found:ceis,cnep_found:cnep,complete:data?.complete===true});
    }
    if(step==="cvm_ipe"){
      const n=Number(data?.filings_found||0);
      await setStep(step,n>0?"COMPLETED":"PARTIAL",n>0?n+" documento(s)/evento(s) relevante(s) localizado(s) no índice oficial IPE/CVM.":"Nenhum documento relevante localizado no recorte IPE consultado; isso não prova ausência de evento corporativo.",undefined,{filings_found:n,years:data?.years||[]});
    }
    if(step==="cvm"){
      cvmFound=typeof data?.found==='boolean'?data.found:null;
      await setStep(step,"COMPLETED",data?.found?"Registro CVM localizado e persistido com evidência.":"CNPJ não localizado no cadastro de companhias abertas consultado; sem inferência além disso.",undefined,{found:data?.found});
    }
   };
   // Eligibility is a prerequisite, while the other company queries are independent.
   await runIndependent(connected.filter(([step])=>!['cvm_ipe','financial_statements'].includes(step)),async item=>{
    try{await runConnected(item)}catch(e){await setStep(item[0],'FAILED',undefined,'Consulta interrompida: '+String(e))}
   });
   await runIndependent(connected.filter(([step])=>['cvm_ipe','financial_statements'].includes(step)&&defs.some(s=>s.key===step)),async item=>{
    try{await runConnected(item)}catch(e){await setStep(item[0],'FAILED',undefined,'Consulta interrompida: '+String(e))}
   });
  }else{
   const reason=supportedClusterCompanies.length
     ? supportedClusterCompanies.length+" empresa(s) suportada(s) já foram adicionadas ao ecossistema. Fontes profundas específicas de empresa devem rodar por núcleo para evitar escolher uma empresa principal arbitrariamente."
     : "Depende da resolução de uma empresa/CNPJ primeiro.";
   for(const key of ["financial_filings","financial_statements","bndes_financing","public_contracts","federal_transparency","cvm","cvm_ipe"])if(defs.some(s=>s.key===key))await setStep(key,"BLOCKED",reason,undefined,{supported_company_count:supportedClusterCompanies.length});
  }

  if(defs.some(s=>s.key==="web_context")){
   const webRoute=routes.find(r=>r.key==='web_context');
   if(!webRoute?.selected){await setStep('web_context','BLOCKED','Busca web desativada: acesso não configurado. Nenhum resultado foi simulado.');}
   else{
   await setStep("web_context","RUNNING");
   const {resp,data}=await callFn(url,auth,"web-context-search",{lead_id:leadId,research_run_id:run.id});
   if(!resp.ok)await setStep("web_context",resp.status===428?"BLOCKED":"FAILED",undefined,data?.error||("HTTP "+resp.status),{action_url:data?.setup_url||null});
   else await setStep("web_context",data?.status==="PARTIAL"?"PARTIAL":"COMPLETED","Contexto web consultado. Resultados são pistas para revisão, sem confirmação automática de fatos ou identidade.",undefined,{results_found:data?.results_found||0,status:data?.status});
   }
  }
  if(defs.some(s=>s.key==='family_validation'))await setStep('family_validation',lead.kind==='PERSON'?'BLOCKED':'SKIPPED',lead.kind==='PERSON'?'Pistas por sobrenome, município e atividade foram separadas da identidade do lead. Parentesco ainda exige documentos independentes e revisão explícita.':'Etapa familiar não aplicável ao núcleo empresarial.');

  const automated=new Set(["base_empresarial_rfb","brasilapi_cnpj","central_balancos_sped","pncp","portal_transparencia","cvm","cvm_ipe","cvm_dfp","querido_diario","bndes_financing","web_search"]);
  for(const def of defs){
   if(!def.source||automated.has(def.source))continue;
   const src:any=sourceMap.get(def.source);
   await setStep(def.key,"BLOCKED","Fonte "+(src?.name||def.source)+" ainda exige pesquisa manual, credencial ou integração adicional. Nenhum resultado foi fabricado.",undefined,{source_status:src?.connection_status||"UNKNOWN",action_url:src?.action_url||null});
  }

  if(defs.some(s=>s.key==="societies"||s.key==="relationships")){
   const key=defs.some(s=>s.key==="societies")?"societies":"relationships";
   const {count}=await admin.from("relationships").select("*",{count:"exact",head:true}).eq("organization_id",orgId).eq("lead_id",leadId);
   await setStep(key,(count||0)>0?"PARTIAL":"BLOCKED",(count||0)>0?(count||0)+" relação(ões) já mapeada(s); expansão reversa depende das fontes societárias disponíveis.":"Ainda não há relações verificadas para expandir.");
  }

  const {data:statusEvents}=await admin.from("events").select("id").eq("lead_id",leadId).eq("organization_id",orgId).eq("event_type","REGISTRATION_STATUS_CHANGE");
  for(const ev of statusEvents||[]){
   const {data:existing}=await admin.from("investigation_questions").select("id").eq("event_id",ev.id).eq("question_type","ECONOMIC_REASON").maybeSingle();
   if(!existing)await admin.from("investigation_questions").insert({organization_id:orgId,lead_id:leadId,research_run_id:run.id,event_id:ev.id,question_type:"ECONOMIC_REASON",question:"O que explica este evento cadastral? Houve venda, incorporação, reorganização, sucessão, liquidação ou encerramento simples?",status:"OPEN",created_by:user.id});
  }

  if(defs.some(s=>s.key==="events")){
    const {count}=await admin.from("events").select("*",{count:"exact",head:true}).eq("organization_id",orgId).eq("lead_id",leadId);
    await setStep("events",(count||0)>0?"COMPLETED":"PARTIAL",(count||0)>0?(count||0)+" evento(s) consolidado(s) na linha do tempo.":"Nenhum evento factual suficiente foi localizado nas fontes conectadas.");
  }

  if(defs.some(s=>s.key==="signals")){
   await setStep("signals","RUNNING");
   const {resp,data}=await callFn(url,auth,"derive-signals",{lead_id:leadId});
   if(resp.ok)await setStep("signals","COMPLETED",(data?.signals?.length||0)+" sinal(is) consultivo(s) derivado(s) de fatos/evidências.",undefined,{signal_count:data?.signals?.length||0});
   else await setStep("signals","FAILED",undefined,data?.error||("HTTP "+resp.status));
  }

  const {data:steps,error:stepsError}=await admin.from("research_steps").select("status").eq("research_run_id",run.id);
  if(stepsError)throw stepsError;
  const statuses=(steps||[]).map((x:any)=>x.status);
  const counts={completed:statuses.filter((s:string)=>s==="COMPLETED").length,partial:statuses.filter((s:string)=>s==="PARTIAL").length,blocked:statuses.filter((s:string)=>s==="BLOCKED").length,failed:statuses.filter((s:string)=>s==="FAILED").length};
  const finalStatus=counts.failed>0||counts.blocked>0||counts.partial>0||statuses.some((s:string)=>['PENDING','RUNNING'].includes(s))?"PARTIAL":"COMPLETED";
  const finishedRun=await admin.from("research_runs").update({status:finalStatus,finished_at:new Date().toISOString(),counters:counts}).eq("id",run.id).eq('organization_id',orgId);
  if(finishedRun.error)throw Error('Could not finalize research run');
  let historyCapture:any;
  try{const response=await fetch(url+'/functions/v1/capture-intelligence',{method:'POST',headers:{Authorization:auth,'Content-Type':'application/json'},body:JSON.stringify({lead_id:leadId,research_run_id:run.id}),signal:AbortSignal.timeout(25000)});historyCapture=await response.json();}catch{historyCapture={ok:false,error:'History capture pending; retry from dossier'};}
  return new Response(JSON.stringify({ok:true,research_run_id:run.id,status:finalStatus,counters:counts,history_capture:historyCapture,company_id:companyId,cnpj_result:cnpjResult,name_candidates:nameCandidates,supported_cluster_companies:supportedClusterCompanies}),{headers:H});
 }catch(e){
  await admin.from("research_runs").update({status:"FAILED",finished_at:new Date().toISOString(),counters:{fatal_error:String(e)}}).eq("id",run.id);
  return new Response(JSON.stringify({error:"Research orchestration failed",detail:String(e),research_run_id:run.id}),{status:500,headers:H});
 }
});
