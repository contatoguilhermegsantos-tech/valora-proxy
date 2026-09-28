
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const H={"Content-Type":"application/json","Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS"};
import { assessIdentity } from "./policy.ts";
Deno.serve(async(req:Request)=>{
  if(req.method==="OPTIONS")return new Response("ok",{headers:H});
  if(req.method!=="POST")return new Response(JSON.stringify({error:"POST required"}),{status:405,headers:H});
  const auth=req.headers.get("Authorization")||"";
  if(!auth)return new Response(JSON.stringify({error:"Unauthorized"}),{status:401,headers:H});

  const url=Deno.env.get("SUPABASE_URL")!,anon=Deno.env.get("SUPABASE_ANON_KEY")!,service=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const uc=createClient(url,anon,{global:{headers:{Authorization:auth}}});
  const admin=createClient(url,service);
  const {data:{user}}=await uc.auth.getUser();
  if(!user)return new Response(JSON.stringify({error:"Unauthorized"}),{status:401,headers:H});

  const b=await req.json().catch(()=>({}));
  const leadId=String(b.lead_id||"");
  const runId=b.research_run_id?String(b.research_run_id):null;
  if(!leadId)return new Response(JSON.stringify({error:"lead_id required"}),{status:400,headers:H});

  const {data:p}=await admin.from("profiles").select("active_organization_id").eq("id",user.id).maybeSingle();
  const orgId=p?.active_organization_id;
  if(!orgId)return new Response(JSON.stringify({error:"No active organization"}),{status:409,headers:H});
  const {data:m}=await admin.from("organization_members").select("role,status").eq("organization_id",orgId).eq("user_id",user.id).maybeSingle();
  if(m?.status!=="ACTIVE")return new Response(JSON.stringify({error:"No organization access"}),{status:403,headers:H});
  if(m.role==="VIEWER")return new Response(JSON.stringify({error:"Viewer is read-only"}),{status:403,headers:H});
  const {data:lead}=await admin.from("leads").select("*").eq("id",leadId).eq("organization_id",orgId).maybeSingle();
  if(!lead)return new Response(JSON.stringify({error:"Lead not found"}),{status:404,headers:H});

  const attempts:any[]=[];
  const recordAttempt=async(sourceKey:string,sequenceNo:number,status:string,resultSummary:string,metadata:any={})=>{
    const row={organization_id:orgId,lead_id:leadId,research_run_id:runId,source_key:sourceKey,sequence_no:sequenceNo,status,result_summary:resultSummary,metadata,created_by:user.id};
    const {data,error}=await admin.from("identity_source_attempts").insert(row).select("id").single();
    attempts.push({id:data?.id||null,source_key:sourceKey,sequence_no:sequenceNo,status,result_summary:resultSummary,metadata,persist_error:error?.message||null});
  };

  let discovery:any=null;
  if(b.run_discovery!==false && lead.kind==="PERSON"){
    try{
      const r=await fetch(url+"/functions/v1/name-company-discovery",{method:"POST",signal:AbortSignal.timeout(25000),headers:{Authorization:auth,"Content-Type":"application/json"},body:JSON.stringify({lead_id:leadId,research_run_id:runId})});
      const txt=await r.text();try{discovery=txt?JSON.parse(txt):null}catch{discovery={error:"Invalid discovery response"}}
      if(r.ok){
        const n=Number(discovery?.candidates_found||0);
        await recordAttempt("base_empresarial_rfb",1,n>0?"CANDIDATES_FOUND":"NO_MATCH",n>0?String(n)+" candidato(s) societário(s) localizado(s) pelo nome.":"Nenhum candidato societário localizado por nome nesta fonte.",{candidates_found:n});
      }else{
        await recordAttempt("base_empresarial_rfb",1,"FAILED",String(discovery?.error||("HTTP "+r.status)),{http_status:r.status});
      }
    }catch(e){
      discovery={error:String(e)};
      await recordAttempt("base_empresarial_rfb",1,"FAILED","Falha de rede na descoberta por nome.",{error:String(e)});
    }
  }

  let {data:candidates,error:ce}=await admin.from("candidate_entities").select("*")
    .eq("organization_id",orgId).eq("lead_id",leadId).eq("candidate_type","RFB_QSA_NAME_MATCH")
    .neq("validation_status","REJECTED");
  if(ce)return new Response(JSON.stringify({error:ce.message}),{status:500,headers:H});
  if(b.run_discovery===false){
    const n=(candidates||[]).length;
    await recordAttempt("base_empresarial_rfb",1,n>0?"CANDIDATES_FOUND":"NO_MATCH",n>0?String(n)+" candidato(s) existentes reaproveitados da descoberta por nome.":"Nenhum candidato societário disponível após a descoberta por nome.",{candidates_found:n,reused:true});
  }

  if((candidates||[]).length>=2){
    try{
      const cr=await fetch(url+"/functions/v1/cross-validate-identity-links",{
        method:"POST",signal:AbortSignal.timeout(25000),headers:{Authorization:auth,"Content-Type":"application/json"},
        body:JSON.stringify({lead_id:leadId,research_run_id:runId})
      });
      const ct=await cr.text();let cd:any=null;try{cd=ct?JSON.parse(ct):null}catch{cd={error:"Invalid cross identity response"}}
      if(cr.ok){
        const groups=Array.isArray(cd?.groups)?cd.groups:[];
        const matched=groups.reduce((s:number,g:any)=>s+Number(g?.size||0),0);
        await recordAttempt("brasilapi_cnpj_cross",2,matched>0?"CANDIDATES_FOUND":"NO_MATCH",
          matched>0?matched+" vínculo(s) empresarial(is) agrupado(s) por identificador fiscal mascarado consistente no QSA.":"Nenhum agrupamento cruzado conclusivo foi produzido entre os candidatos atuais.",
          {groups:groups.map((g:any)=>({group_id:g.group_id,size:g.size,anchor_confirmed:Boolean(g.anchor_confirmed)})),candidates_checked:cd?.candidates_checked||0});
        const refreshed=await admin.from("candidate_entities").select("*")
          .eq("organization_id",orgId).eq("lead_id",leadId).eq("candidate_type","RFB_QSA_NAME_MATCH")
          .neq("validation_status","REJECTED");
        if(!refreshed.error)candidates=refreshed.data||candidates;
      }else{
        await recordAttempt("brasilapi_cnpj_cross",2,"FAILED",String(cd?.error||("HTTP "+cr.status)),{http_status:cr.status});
      }
    }catch(e){
      await recordAttempt("brasilapi_cnpj_cross",2,"FAILED","Falha na validação cruzada de identidade por QSA.",{error:String(e)});
    }
  }

  const {scored,top,ambiguous,ambiguousCandidateIds}=assessIdentity(lead,candidates||[]);

  if(b.run_fallback===true && lead.kind==="PERSON" && (!top || top.score<75 || ambiguous)){
    if(lead.city){
      try{
        const qr=await fetch(url+"/functions/v1/querido-diario-search",{method:"POST",signal:AbortSignal.timeout(25000),headers:{Authorization:auth,"Content-Type":"application/json"},body:JSON.stringify({lead_id:leadId,max_results:8,research_run_id:runId,terms:[lead.name]})});
        const qt=await qr.text();let qd:any=null;try{qd=qt?JSON.parse(qt):null}catch{qd={error:"Invalid Querido Diário response"}}
        if(qr.ok){
          const n=Number(qd?.mentions_found||0);
          const status=qd?.territory_found===false?"NOT_COVERED":n>0?"MENTIONS_FOUND":"NO_MATCH";
          await recordAttempt("querido_diario",3,status,
            qd?.territory_found===false?"Município fora da cobertura localizada do Querido Diário.":n>0?String(n)+" menção(ões) pública(s) localizada(s) para validação contextual.":"Nenhuma menção localizada na cobertura municipal consultada.",
            {territory_id:qd?.territory_id||null,mentions_found:n});
        }else await recordAttempt("querido_diario",3,"FAILED",String(qd?.error||("HTTP "+qr.status)),{http_status:qr.status});
      }catch(e){await recordAttempt("querido_diario",3,"FAILED","Falha na consulta contextual municipal.",{error:String(e)})}
    }else{
      await recordAttempt("querido_diario",3,"SKIPPED","Cidade não informada; fallback municipal não foi executado.");
    }

    if(String(lead.state||"").toUpperCase()==="SP"){
      await recordAttempt("jucesp",4,"MANUAL_REQUIRED","JUCESP permanece como rota oficial de validação societária/histórica; automação robusta ainda não conectada.",{action_url:"https://www.jucesponline.sp.gov.br/"});
    }
    await recordAttempt("dou",5,"MANUAL_REQUIRED","DOU permanece como rota documental oficial complementar; correspondência nominal precisa ser validada no documento.",{action_url:"https://www.in.gov.br/consulta"});

    try{
      const wr=await fetch(url+"/functions/v1/web-context-search",{method:"POST",signal:AbortSignal.timeout(25000),headers:{Authorization:auth,"Content-Type":"application/json"},body:JSON.stringify({lead_id:leadId,research_run_id:runId})});
      const wt=await wr.text();let wd:any=null;try{wd=wt?JSON.parse(wt):null}catch{wd={error:"Invalid web context response"}}
      if(wr.ok){
        const n=Number(wd?.results_found||0);
        await recordAttempt("web_search",6,n>0?"CANDIDATES_FOUND":"NO_MATCH",
          n>0?String(n)+" resultado(s) web contextual(is) persistido(s) como candidatos; nenhum snippet foi promovido a fato.":"Nenhum resultado web contextual persistido nesta consulta.",
          {provider:wd?.provider||"BRAVE",results_found:n,queries:wd?.queries||[]});
      }else if(wr.status===428){
        await recordAttempt("web_search",6,"CONFIG_REQUIRED","Conector web implementado, mas a chave do provedor ainda não está configurada no backend.",{provider:wd?.provider||"BRAVE",setup_url:wd?.setup_url||null});
      }else{
        await recordAttempt("web_search",6,"FAILED",String(wd?.error||("HTTP "+wr.status)),{http_status:wr.status});
      }
    }catch(e){
      await recordAttempt("web_search",6,"FAILED","Falha ao executar a camada web contextual.",{error:String(e)});
    }
  }

  const now=new Date().toISOString();
  const output:any[]=[];
  for(let i=0;i<scored.length;i++){
    const x=scored[i];
    let decision=x.decision;
    if(ambiguousCandidateIds.has(x.candidate.id)&&x.decision!=="CONFIRMED")decision="AMBIGUOUS";
    const explanation=decision==="CONFIRMED"
      ?"Vínculo confirmado explicitamente pelo usuário."
      :decision==="SUPPORTED"
        ?"Conjunto de sinais contextuais suficiente para suporte algorítmico; ainda não equivale a confirmação humana."
        :decision==="AMBIGUOUS"
          ?"Há pelo menos dois candidatos com pontuação muito próxima; o MAX exige desambiguação."
          :decision==="REVIEW"
            ?"Há aderência parcial, mas não suficiente para atribuir identidade."
            :"Sinais contextuais fracos; não atribuir identidade.";

    const {data:assessment,error:assessmentError}=await admin.from("identity_assessments").insert({
      organization_id:orgId,lead_id:leadId,candidate_entity_id:x.candidate.id,research_run_id:runId,
      score:x.score,decision,factors:x.factors,engine_version:"identity-v1.2",explanation,created_by:user.id
    }).select("id").single();

    if(assessmentError)return new Response(JSON.stringify({error:assessmentError.message}),{status:500,headers:H});
    let nextValidation=x.candidate.validation_status;
    if(nextValidation==="UNVALIDATED"){
      if(decision==="SUPPORTED")nextValidation="SUPPORTED";
    }else if(nextValidation==="SUPPORTED"&&decision!=="SUPPORTED"&&decision!=="CONFIRMED"){
      nextValidation="UNVALIDATED";
    }
    const confidence=x.score>=75?"HIGH":x.score>=45?"MEDIUM":"LOW";
    const update=admin.from("candidate_entities").update({
      confidence,validation_status:nextValidation,
      metadata:{...(x.candidate.metadata||{}),identity_engine:{score:x.score,decision,ambiguous:ambiguousCandidateIds.has(x.candidate.id),engine_version:"identity-v1.2",assessed_at:now}}
    }).eq("id",x.candidate.id).eq("organization_id",orgId);
    // A concurrent user confirmation or rejection always wins over this assessment.
    const {error:updateError}=await update.eq("validation_status",x.candidate.validation_status);
    if(updateError)return new Response(JSON.stringify({error:updateError.message}),{status:500,headers:H});

    output.push({assessment_id:assessment?.id||null,candidate_id:x.candidate.id,label:x.candidate.label,score:x.score,decision,confidence,factors:x.factors});
  }

  const wasVerified=lead.identity_status==="VERIFIED"&&lead.identity_confirmed_by_user===true;
  let leadStatus=lead.identity_status;
  let confirmed=lead.identity_confirmed_by_user;
  if(!wasVerified){
    if(output.some(x=>x.decision==="CONFIRMED")){leadStatus="VERIFIED";confirmed=true}
    else if(ambiguous){leadStatus="CAUTION"}
    else if(top?.score>=75){leadStatus="SUPPORTED"}
    else if(output.length){leadStatus="CAUTION"}
    else {leadStatus="PENDING";confirmed=false}
    await admin.from("leads").update({identity_status:leadStatus,identity_confirmed_by_user:confirmed,updated_at:now})
      .eq("id",leadId).eq("organization_id",orgId).eq("identity_status",lead.identity_status).eq("identity_confirmed_by_user",lead.identity_confirmed_by_user);
  }

  return new Response(JSON.stringify({
    ok:true,lead_id:leadId,lead_status:wasVerified?"VERIFIED":leadStatus,
    ambiguity:ambiguous,candidates_assessed:output.length,candidates:output,
    discovery_note:discovery?.caveat||discovery?.note||null,
    source_attempts:attempts,
    rule:"SUPPORTED é suporte algorítmico. VERIFIED exige confirmação explícita do usuário ou fluxo equivalente documentado."
  }),{headers:H});
});

