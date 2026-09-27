
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const H={"Content-Type":"application/json","Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, GET, OPTIONS"};
type Strategy="EMPRESARIO"|"AGRO"|"MEDICO"|"GENERICO";
type StepDef={key:string;title:string;source?:string};

const COMMON_COMPANY:StepDef[]=[
 {key:"cnpj_qsa",title:"Consultar cadastro empresarial e quadro societário",source:"brasilapi_cnpj"},
 {key:"financial_filings",title:"Buscar demonstrações e atos societários na Central de Balanços",source:"central_balancos_sped"},
 {key:"municipal_gazettes",title:"Buscar menções em Diários Oficiais municipais",source:"querido_diario"},
 {key:"bndes_financing",title:"Verificar operações de financiamento no BNDES",source:"bndes_financing"},
 {key:"public_contracts",title:"Verificar contratos públicos na cobertura PNCP",source:"pncp"}
];

const STRATEGIES:Record<Strategy,StepDef[]>={
 EMPRESARIO:[
  {key:"identity",title:"Validar identidade e contexto inicial"},...COMMON_COMPANY,
  {key:"cvm",title:"Verificar cadastro em companhias abertas",source:"cvm"},
  {key:"cvm_ipe",title:"Buscar documentos e eventos corporativos no IPE/CVM",source:"cvm_ipe"},
  {key:"corporate_history",title:"Investigar histórico societário e arquivamentos",source:"jucesp"},
  {key:"mna",title:"Verificar M&A / atos de concentração",source:"cade"},
  {key:"web_context",title:"Buscar contexto corporativo complementar",source:"web_search"},
  {key:"events",title:"Consolidar eventos econômicos e questões investigativas"},
  {key:"signals",title:"Derivar sinais consultivos somente a partir de evidências"}
 ],
 AGRO:[
  {key:"identity",title:"Validar identidade, município e atividade agro"},...COMMON_COMPANY,
  {key:"surname_candidates",title:"Criar pivô de sobrenome/localidade sem confirmar parentesco"},
  {key:"family_validation",title:"Validar candidatos familiares por fontes independentes",source:"web_search"},
  {key:"corporate_history",title:"Investigar histórico societário",source:"jucesp"},
  {key:"web_context",title:"Buscar contexto agro/corporativo complementar",source:"web_search"},
  {key:"events",title:"Consolidar eventos econômicos e questões investigativas"},
  {key:"signals",title:"Derivar sinais consultivos somente a partir de evidências"}
 ],
 MEDICO:[
  {key:"identity",title:"Validar identidade profissional e empresarial"},...COMMON_COMPANY,
  {key:"cvm",title:"Verificar eventual cadastro em companhias abertas",source:"cvm"},
  {key:"cvm_ipe",title:"Buscar documentos e eventos corporativos no IPE/CVM",source:"cvm_ipe"},
  {key:"societies",title:"Expandir sociedades, sócios e administradores"},
  {key:"web_context",title:"Buscar contexto corporativo/profissional complementar",source:"web_search"},
  {key:"events",title:"Investigar eventos empresariais relevantes"},
  {key:"signals",title:"Derivar sinais consultivos somente a partir de evidências"}
 ],
 GENERICO:[
  {key:"identity",title:"Validar identidade"},...COMMON_COMPANY,
  {key:"cvm",title:"Verificar cadastro em companhias abertas",source:"cvm"},
  {key:"cvm_ipe",title:"Buscar documentos e eventos corporativos no IPE/CVM",source:"cvm_ipe"},
  {key:"relationships",title:"Expandir relações empresariais existentes"},
  {key:"web_context",title:"Buscar contexto público complementar",source:"web_search"},
  {key:"events",title:"Consolidar eventos e pendências"},
  {key:"signals",title:"Derivar sinais consultivos somente a partir de evidências"}
 ]
};

async function callFn(url:string,auth:string,name:string,body:any){
 const resp=await fetch(url+"/functions/v1/"+name,{method:"POST",headers:{Authorization:auth,"Content-Type":"application/json"},body:JSON.stringify(body)});
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
 const requestCnpj=String(b.cnpj||"").replace(/\D/g,"");
 if(!leadId||!(strategy in STRATEGIES))return new Response(JSON.stringify({error:"lead_id/strategy invalid"}),{status:400,headers:H});

 const {data:p}=await admin.from("profiles").select("active_organization_id").eq("id",user.id).maybeSingle();
 const orgId=p?.active_organization_id;
 if(!orgId)return new Response(JSON.stringify({error:"No active organization"}),{status:409,headers:H});
 const {data:membership}=await admin.from("organization_members").select("status").eq("organization_id",orgId).eq("user_id",user.id).maybeSingle();
 if(membership?.status!=="ACTIVE")return new Response(JSON.stringify({error:"No organization access"}),{status:403,headers:H});
 const {data:lead}=await admin.from("leads").select("*").eq("id",leadId).eq("organization_id",orgId).maybeSingle();
 if(!lead)return new Response(JSON.stringify({error:"Lead not found"}),{status:404,headers:H});
 const cnpj=requestCnpj.length===14?requestCnpj:String(lead.initial_cnpj||"").replace(/\D/g,"");

 const {data:sources}=await admin.from("source_registry").select("key,name,connection_status,action_url,limitations");
 const sourceMap=new Map((sources||[]).map((s:any)=>[s.key,s]));
 const {data:run,error:runError}=await admin.from("research_runs").insert({
  organization_id:orgId,lead_id:leadId,strategy,objective:b.objective||"Qualificação profunda baseada em evidências",
  status:"RUNNING",started_at:new Date().toISOString(),created_by:user.id
 }).select("id").single();
 if(runError)return new Response(JSON.stringify({error:runError.message}),{status:500,headers:H});

 const defs=STRATEGIES[strategy];
 await admin.from("research_steps").insert(defs.map((s,i)=>{
  const src:any=s.source?sourceMap.get(s.source):null;
  return {organization_id:orgId,research_run_id:run.id,step_key:s.key,step_order:i+1,title:s.title,source_key:s.source||null,status:"PENDING",action_url:src?.action_url||null,metadata:src?{source_status:src.connection_status,limitations:src.limitations}:{}};
 }));

 const setStep=async(key:string,status:string,summary?:string,error?:string,extra:any={})=>{
  const patch:any={status,result_summary:summary||null,error_summary:error||null,metadata:extra};
  if(status==="RUNNING")patch.started_at=new Date().toISOString();
  if(["COMPLETED","PARTIAL","BLOCKED","FAILED","SKIPPED"].includes(status))patch.finished_at=new Date().toISOString();
  await admin.from("research_steps").update(patch).eq("research_run_id",run.id).eq("step_key",key);
 };

 try{
  await setStep("identity","COMPLETED","Lead carregado; identidade continua com o status cadastrado no dossiê.",undefined,{identity_status:lead.identity_status});
  let companyId:string|null=null,cnpjResult:any=null;

  if(cnpj.length===14){
   await setStep("cnpj_qsa","RUNNING");
   const {resp,data}=await callFn(url,auth,"cnpj-enrich",{lead_id:leadId,cnpj});
   cnpjResult=data;
   if(resp.ok&&data?.company_id){
    companyId=data.company_id;
    await setStep("cnpj_qsa","COMPLETED","Cadastro consultado. "+(data.relationship_ids?.length||0)+" relação(ões) de QSA persistida(s) com evidência.",undefined,{company_id:companyId,evidence_id:data.evidence_id});
   }else await setStep("cnpj_qsa","FAILED",undefined,data?.error||("HTTP "+resp.status));
  }else await setStep("cnpj_qsa","BLOCKED","CNPJ ainda não disponível; a etapa não foi simulada.");

  if(defs.some(s=>s.key==="municipal_gazettes")){
   await setStep("municipal_gazettes","RUNNING");
   const {resp,data}=await callFn(url,auth,"querido-diario-search",{lead_id:leadId,max_results:10,research_run_id:run.id});
   if(resp.ok){
    const found=Number(data?.mentions_found||0);
    await setStep("municipal_gazettes",found>0?"COMPLETED":"PARTIAL",
      found>0?found+" menção(ões) localizada(s) em Diários Oficiais municipais.":(data?.territory_found===false?"Município não está coberto/localizado no Querido Diário.":"Nenhuma menção encontrada na cobertura municipal consultada; isso não prova inexistência."),
      undefined,{territory_id:data?.territory_id||null,mentions_found:found,terms_searched:data?.terms_searched||[]});
   }else await setStep("municipal_gazettes","FAILED",undefined,data?.error||("HTTP "+resp.status));
  }

  if(strategy==="AGRO"){
   const surname=String(lead.name||"").trim().split(/\s+/).filter(Boolean).slice(-1)[0]||null;
   if(surname){
    const {data:existing}=await admin.from("candidate_entities").select("id").eq("organization_id",orgId).eq("lead_id",leadId).eq("candidate_type","FAMILY_SEARCH_PIVOT").maybeSingle();
    if(!existing)await admin.from("candidate_entities").insert({organization_id:orgId,lead_id:leadId,research_run_id:run.id,entity_type:"GROUP",label:"Candidatos com sobrenome "+surname+" em "+(lead.city||"localidade a validar"),candidate_reason:"Sobrenome e localidade são apenas pivô de descoberta. Não confirmam parentesco.",candidate_type:"FAMILY_SEARCH_PIVOT",confidence:"LOW",validation_status:"UNVALIDATED",metadata:{surname,city:lead.city,state:lead.state,segment:lead.segment},created_by:user.id});
    await setStep("surname_candidates","PARTIAL","Pivô familiar criado. Nenhuma pessoa foi classificada como familiar sem validação independente.",undefined,{surname,city:lead.city,state:lead.state});
   }else await setStep("surname_candidates","BLOCKED","Não foi possível extrair sobrenome útil do lead.");
  }

  if(companyId){
   const connected=[
    ["financial_filings","central-balancos-search"],
    ["bndes_financing","bndes-company-financing"],
    ["public_contracts","pncp-company-contracts"],
    ["cvm_ipe","cvm-ipe-search"],
    ["cvm","cvm-company-check"]
   ] as const;

   for(const [step,fn] of connected){
    if(!defs.some(s=>s.key===step))continue;
    await setStep(step,"RUNNING");
    const {resp,data}=await callFn(url,auth,fn,{lead_id:leadId,company_id:companyId,research_run_id:run.id});
    if(!resp.ok){await setStep(step,"FAILED",undefined,data?.error||("HTTP "+resp.status));continue}

    if(step==="financial_filings"){
      const n=Number(data?.documents_found||0);
      await setStep(step,n>0?"COMPLETED":"PARTIAL",
        n>0?n+" documento(s) localizado(s) na Central de Balanços; metadados, evidências e eventos foram persistidos.":"Nenhum documento localizado na Central de Balanços para este CNPJ; isso não prova ausência de demonstrações ou atos.",
        undefined,{documents_found:n,documents_processed:data?.documents_processed||0,persisted:data?.persisted||0,truncated:Boolean(data?.truncated)});
    }
    if(step==="bndes_financing"){
      const n=Number(data?.operations_found||0);
      await setStep(step,n>0?"COMPLETED":"PARTIAL",n>0?n+" operação(ões) de financiamento BNDES localizada(s) e persistida(s) com evidência oficial.":"Nenhuma operação localizada nas bases consultadas do BNDES; isso não prova ausência de crédito por outras fontes.",undefined,{operations_found:n});
    }
    if(step==="public_contracts"){
      const n=Number(data?.contracts_found||0);
      await setStep(step,n>0?"COMPLETED":"PARTIAL",n>0?n+" contrato(s) público(s) encontrado(s) na cobertura indexada.":"Nenhum contrato encontrado na cobertura indexada atual. Isso não é tratado como prova de inexistência.",undefined,data||{});
    }
    if(step==="cvm_ipe"){
      const n=Number(data?.filings_found||0);
      await setStep(step,n>0?"COMPLETED":"PARTIAL",n>0?n+" documento(s)/evento(s) relevante(s) localizado(s) no índice oficial IPE/CVM.":"Nenhum documento relevante localizado no recorte IPE consultado; isso não prova ausência de evento corporativo.",undefined,{filings_found:n,years:data?.years||[]});
    }
    if(step==="cvm")await setStep(step,"COMPLETED",data?.found?"Registro CVM localizado e persistido com evidência.":"CNPJ não localizado no cadastro de companhias abertas consultado; sem inferência além disso.",undefined,{found:data?.found});
   }
  }else{
   for(const key of ["financial_filings","bndes_financing","public_contracts","cvm","cvm_ipe"])if(defs.some(s=>s.key===key))await setStep(key,"BLOCKED","Depende da resolução de uma empresa/CNPJ primeiro.");
  }

  const automated=new Set(["brasilapi_cnpj","central_balancos_sped","pncp","cvm","cvm_ipe","querido_diario","bndes_financing"]);
  for(const def of defs){
   if(!def.source||automated.has(def.source))continue;
   const src:any=sourceMap.get(def.source);
   if(!src||!["CONNECTED","CONNECTED_LIMITED"].includes(src.connection_status))
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

  const {data:steps}=await admin.from("research_steps").select("status").eq("research_run_id",run.id);
  const statuses=(steps||[]).map((x:any)=>x.status);
  const counts={completed:statuses.filter((s:string)=>s==="COMPLETED").length,partial:statuses.filter((s:string)=>s==="PARTIAL").length,blocked:statuses.filter((s:string)=>s==="BLOCKED").length,failed:statuses.filter((s:string)=>s==="FAILED").length};
  const finalStatus=counts.failed>0||counts.blocked>0||counts.partial>0?"PARTIAL":"COMPLETED";
  await admin.from("research_runs").update({status:finalStatus,finished_at:new Date().toISOString(),counters:counts}).eq("id",run.id);
  return new Response(JSON.stringify({ok:true,research_run_id:run.id,status:finalStatus,counters:counts,company_id:companyId,cnpj_result:cnpjResult}),{headers:H});
 }catch(e){
  await admin.from("research_runs").update({status:"FAILED",finished_at:new Date().toISOString(),counters:{fatal_error:String(e)}}).eq("id",run.id);
  return new Response(JSON.stringify({error:"Research orchestration failed",detail:String(e),research_run_id:run.id}),{status:500,headers:H});
 }
});
