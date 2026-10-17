import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const H={"Content-Type":"application/json","Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, GET, OPTIONS"};
const uniq=<T,>(a:T[])=>[...new Set(a)];

Deno.serve(async(req:Request)=>{
 try{
  if(req.method==="OPTIONS") return new Response("ok",{headers:H});
  if(req.method!=="POST") return new Response(JSON.stringify({error:"POST required"}),{status:405,headers:H});
  const auth=req.headers.get("Authorization");
  if(!auth) return new Response(JSON.stringify({error:"Unauthorized"}),{status:401,headers:H});
  const url=Deno.env.get("SUPABASE_URL")!, anon=Deno.env.get("SUPABASE_ANON_KEY")!, service=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const userClient=createClient(url,anon,{global:{headers:{Authorization:auth}}});
  const admin=createClient(url,service);
  const {data:{user}}=await userClient.auth.getUser();
  if(!user) return new Response(JSON.stringify({error:"Unauthorized"}),{status:401,headers:H});

  const body=await req.json().catch(()=>({}));
  const leadId=String(body.lead_id||"");
  if(!leadId) return new Response(JSON.stringify({error:"lead_id required"}),{status:400,headers:H});
  const {data:profile,error:profileError}=await admin.from("profiles").select("active_organization_id").eq("id",user.id).single();
  if(profileError)return new Response(JSON.stringify({error:"Could not validate organization"}),{status:500,headers:H});
  const orgId=profile?.active_organization_id;
  if(!orgId) return new Response(JSON.stringify({error:"No active organization"}),{status:409,headers:H});
  const {data:membership,error:memberError}=await admin.from("organization_members").select("role,status").eq("organization_id",orgId).eq("user_id",user.id).maybeSingle();
  if(memberError)return new Response(JSON.stringify({error:"Could not validate research permission"}),{status:500,headers:H});
  if(membership?.status!=="ACTIVE"||!["OWNER","ADMIN","ANALYST","MEMBER"].includes(membership.role))return new Response(JSON.stringify({error:"Research permission required"}),{status:403,headers:H});
  const {data:lead,error:leadError}=await admin.from("leads").select("*").eq("id",leadId).eq("organization_id",orgId).maybeSingle();
  if(leadError)return new Response(JSON.stringify({error:"Could not read lead"}),{status:500,headers:H});
  if(!lead) return new Response(JSON.stringify({error:"Lead not found"}),{status:404,headers:H});

  const [eventsQ,relsQ,claimsQ,divsQ,contractsQ,evidenceQ,companiesQ]=await Promise.all([
    admin.from("events").select("*,event_evidence(evidence_id,support_type)").eq("lead_id",leadId).eq("organization_id",orgId),
    admin.from("relationships").select("*,relationship_evidence(evidence_id,support_type)").eq("lead_id",leadId).eq("organization_id",orgId),
    admin.from("claims").select("*,claim_evidence(evidence_id,support_type)").eq("lead_id",leadId).eq("organization_id",orgId),
    admin.from("divergences").select("*").eq("lead_id",leadId).eq("organization_id",orgId).eq("status","OPEN"),
    admin.from("commercial_signals").select("*").eq("lead_id",leadId).eq("organization_id",orgId),
    admin.from("evidence").select("id,verification_status,organization_id,lead_id").eq("lead_id",leadId).eq("organization_id",orgId),
    admin.from("lead_company_links").select("company_id,status").eq("lead_id",leadId).eq("organization_id",orgId)
  ]);
  if([eventsQ,relsQ,claimsQ,divsQ,contractsQ,evidenceQ,companiesQ].some(q=>q.error))return new Response(JSON.stringify({error:"Could not read current signal support"}),{status:500,headers:H});
  const verified=new Set((evidenceQ.data||[]).filter((e:any)=>e.organization_id===orgId&&e.lead_id===leadId&&e.verification_status==="VERIFIED").map((e:any)=>e.id));
  const companies=new Set((companiesQ.data||[]).filter((l:any)=>["SUPPORTED","VERIFIED"].includes(l.status)).map((l:any)=>l.company_id));
  const support=(row:any,key:string)=>(row[key]||[]).filter((r:any)=>r.support_type==="SUPPORTS"&&verified.has(r.evidence_id));
  const allowedCompany=(row:any)=>!row.company_id||companies.has(row.company_id);
  const fact=(row:any,key:string)=>row.organization_id===orgId&&row.lead_id===leadId&&row.classification==="FACT"&&row.status==="VERIFIED"&&allowedCompany(row)&&support(row,key).length>0&&!(row[key]||[]).some((r:any)=>r.support_type==="CONTRADICTS"&&verified.has(r.evidence_id));
  const events=(eventsQ.data||[]).filter((e:any)=>fact(e,"event_evidence"));
  const rels=(relsQ.data||[]).filter((r:any)=>fact(r,"relationship_evidence")&&(!r.from_entity_id||r.from_entity_type!=="COMPANY"||companies.has(r.from_entity_id))&&(!r.to_entity_id||r.to_entity_type!=="COMPANY"||companies.has(r.to_entity_id)));
  const claims=(claimsQ.data||[]).filter((c:any)=>fact(c,"claim_evidence"));
  const claimIds=new Set(claims.map((c:any)=>c.id));
  const divs=(divsQ.data||[]).filter((d:any)=>d.organization_id===orgId&&d.lead_id===leadId&&claimIds.has(d.claim_a_id)&&claimIds.has(d.claim_b_id));
  const existing=contractsQ.data||[];
  const existingMap=new Map<string,any>();
  for(const row of existing){const current=existingMap.get(row.signal_type);if(!current||current.status==="ACTIVE"&&row.status!=="ACTIVE")existingMap.set(row.signal_type,row);}
  const generated=new Set<string>();
  // These types are emitted by this connector. Other types and non-active reviews are preserved.
  const managed=new Set(["CORPORATE_STATUS_EVENT","POSSIBLE_LIQUIDITY_EVENT","POSSIBLE_SUCCESSION","BNDES_FINANCING_HISTORY","PUBLIC_CONTRACT_PATTERN","DATA_CONTRADICTION"]);
  const save=async(signal:any)=>{
    generated.add(signal.signal_type);
    const current=existingMap.get(signal.signal_type);
    if(current&&current.status!=="ACTIVE")return;
    const payload={...signal,organization_id:orgId,lead_id:leadId,updated_at:new Date().toISOString()};
    if(current){
      const result=await admin.from("commercial_signals").update(payload).eq("id",current.id).eq("organization_id",orgId).eq("lead_id",leadId).eq("status","ACTIVE").eq("updated_at",current.updated_at).select("id").maybeSingle();
      if(result.error)throw new Error("Could not update derived signal");
    }else{
      const result=await admin.from("commercial_signals").insert({...payload,created_by:user.id}).select("*").single();
      if(result.error||!result.data)throw new Error("Could not persist derived signal");
      existingMap.set(signal.signal_type,result.data);
    }
  };

  const statusEvents=events.filter((e:any)=>e.event_type==="REGISTRATION_STATUS_CHANGE" && e.status==="VERIFIED");
  if(statusEvents.length){
    const ev=statusEvents[0];
    await save({
      signal_type:"CORPORATE_STATUS_EVENT",
      title:"Evento cadastral relevante identificado",
      summary:`${ev.title}. O evento cadastral está documentado, mas a causa econômica não é inferida automaticamente.`,
      classification:"FACT",confidence:"HIGH",status:"ACTIVE",
      evidence_ids:uniq(statusEvents.flatMap((e:any)=>support(e,"event_evidence").map((x:any)=>x.evidence_id))),
      claim_ids:[],event_ids:statusEvents.map((e:any)=>e.id),
      commercial_theme:"Reorganização societária, continuidade empresarial, sucessão, tributação",
      discovery_question:"O que motivou a alteração cadastral e como a operação/ativos foram reorganizados depois do evento?",
      caution:"Baixa, inaptidão, suspensão ou liquidação cadastral não prova venda, falência, sucessão ou evento de liquidez."
    });
  }

  const mnaEvents=events.filter((e:any)=>["MNA","COMPANY_SALE","ACQUISITION","MERGER","INCORPORATION"].includes(String(e.event_type).toUpperCase()) && e.status==="VERIFIED");
  if(mnaEvents.length){
    await save({
      signal_type:"POSSIBLE_LIQUIDITY_EVENT",
      title:"Evento societário compatível com possível liquidez",
      summary:`${mnaEvents.length} evento(s) de M&A/venda/incorporação verificado(s) no ecossistema pesquisado. A existência da operação não determina quanto o lead recebeu.`,
      classification:"INDICATION",confidence:"HIGH",status:"ACTIVE",
      evidence_ids:uniq(mnaEvents.flatMap((e:any)=>support(e,"event_evidence").map((x:any)=>x.evidence_id))),
      claim_ids:[],event_ids:mnaEvents.map((e:any)=>e.id),
      commercial_theme:"Planejamento pós-liquidez, diversificação, tributação, wealth management",
      discovery_question:"Como os recursos e participações decorrentes da operação foram estruturados e quais objetivos patrimoniais passaram a ser prioritários?",
      caution:"Valor total da transação não pode ser atribuído ao lead sem evidência de participação, condições, dívidas, impostos e valor efetivamente recebido."
    });
  }

  const family=rels.filter((r:any)=>r.relationship_type==="FAMILIAR_CONFIRMADO" && r.status==="VERIFIED");
  const holdings=events.filter((e:any)=>["HOLDING_CREATED","HOLDING_FORMATION"].includes(String(e.event_type).toUpperCase()) && e.status==="VERIFIED");
  const adminChanges=events.filter((e:any)=>["ADMIN_CHANGE","SHAREHOLDER_ENTRY","SHAREHOLDER_EXIT","FOUNDER_EXIT"].includes(String(e.event_type).toUpperCase()) && e.status==="VERIFIED");
  const successionPieces=(family.length?1:0)+(holdings.length?1:0)+(adminChanges.length?1:0);
  if(successionPieces>=2){
    const confidence=successionPieces===3?"HIGH":"MEDIUM";
    await save({
      signal_type:"POSSIBLE_SUCCESSION",
      title:"Padrão compatível com possível sucessão/reorganização familiar",
      summary:"Há combinação de fatos verificados envolvendo estrutura familiar, holding e/ou mudança societária/administrativa. O sistema trata isso como hipótese consultiva, não como sucessão declarada.",
      classification:"HYPOTHESIS",confidence,status:"ACTIVE",
      evidence_ids:uniq([
        ...family.flatMap((r:any)=>support(r,"relationship_evidence").map((x:any)=>x.evidence_id)),
        ...holdings.flatMap((e:any)=>support(e,"event_evidence").map((x:any)=>x.evidence_id)),
        ...adminChanges.flatMap((e:any)=>support(e,"event_evidence").map((x:any)=>x.evidence_id))
      ]),
      claim_ids:[],event_ids:uniq([...holdings.map((e:any)=>e.id),...adminChanges.map((e:any)=>e.id)]),
      commercial_theme:"Sucessão patrimonial, governança familiar, tributação, holdings e planejamento de longo prazo",
      discovery_question:"Há algum movimento formal de sucessão, reorganização patrimonial ou transferência de responsabilidades entre gerações em andamento?",
      caution:"Interpretação do sistema. Sem documento ou declaração explícita, não afirmar que existe planejamento sucessório."
    });
  }

  const bndesEvents=events.filter((e:any)=>String(e.event_type).toUpperCase()==="BNDES_FINANCING" && e.status==="VERIFIED");
  if(bndesEvents.length){
    const latest=[...bndesEvents].sort((a:any,b:any)=>String(b.event_date||"").localeCompare(String(a.event_date||"")))[0];
    const totalContracted=bndesEvents.reduce((s:number,e:any)=>s+Number(e.metadata?.contracted_value||0),0);
    const totalDisbursed=bndesEvents.reduce((s:number,e:any)=>s+Number(e.metadata?.disbursed_value||0),0);
    await save({
      signal_type:"BNDES_FINANCING_HISTORY",
      title:"Histórico de financiamento empresarial via BNDES",
      summary:`${bndesEvents.length} operação(ões) de financiamento divulgada(s) pelo BNDES foram localizada(s).${latest?.event_date?` Registro mais recente em ${latest.event_date}.`:""} ${totalContracted>0?`Valor contratado/operação somado nos registros: R$ ${totalContracted.toLocaleString("pt-BR",{maximumFractionDigits:2})}.`:""}`,
      classification:"INDICATION",confidence:"HIGH",status:"ACTIVE",
      evidence_ids:uniq(bndesEvents.flatMap((e:any)=>support(e,"event_evidence").map((x:any)=>x.evidence_id))),
      claim_ids:[],event_ids:bndesEvents.map((e:any)=>e.id),
      commercial_theme:"Estrutura de capital, crédito empresarial, caixa PJ, refinanciamento e gestão de vencimentos",
      discovery_question:"Como estão hoje o saldo, o cronograma de amortização, o custo efetivo e as próximas necessidades de capital da empresa?",
      caution:`Os registros confirmam operações divulgadas pelo BNDES. ${totalDisbursed>0?`Valor desembolsado histórico somado: R$ ${totalDisbursed.toLocaleString("pt-BR",{maximumFractionDigits:2})}. `:""}Eles não confirmam saldo devedor atual, caixa disponível, patrimônio ou liquidez pessoal dos sócios.`
    });
  }

  const verifiedContracts=claims.filter((c:any)=>c.claim_type==="PUBLIC_CONTRACT" && c.status==="VERIFIED");
  if(verifiedContracts.length>=2){
    await save({
      signal_type:"PUBLIC_CONTRACT_PATTERN",title:"Padrão de contratos públicos identificado",
      summary:`${verifiedContracts.length} contratos públicos verificados no dossiê. Isso demonstra relação contratual pública, não pagamento ou caixa recebido.`,
      classification:"INDICATION",confidence:verifiedContracts.length>=5?"HIGH":"MEDIUM",status:"ACTIVE",
      evidence_ids:uniq(verifiedContracts.flatMap((c:any)=>support(c,"claim_evidence").map((x:any)=>x.evidence_id))),
      claim_ids:verifiedContracts.map((c:any)=>c.id),event_ids:[],
      commercial_theme:"Gestão de caixa empresarial, investimentos PJ e planejamento tributário",
      discovery_question:"Como a empresa administra os recebimentos, reservas e necessidades de capital de giro ligadas aos contratos públicos?",
      caution:"Contrato publicado não comprova pagamento, margem ou recorrência financeira."
    });
  }

  if(divs.length){
    await save({
      signal_type:"DATA_CONTRADICTION",
      title:"Divergências de fonte exigem validação",
      summary:`${divs.length} divergência(s) aberta(s) entre fatos/evidências. Nenhuma versão deve ser escolhida silenciosamente.`,
      classification:"FACT",confidence:"HIGH",status:"ACTIVE",
      evidence_ids:uniq(claims.filter((c:any)=>divs.some((d:any)=>d.claim_a_id===c.id||d.claim_b_id===c.id)).flatMap((c:any)=>support(c,"claim_evidence").map((x:any)=>x.evidence_id))),claim_ids:uniq(divs.flatMap((d:any)=>[d.claim_a_id,d.claim_b_id].filter(Boolean))),event_ids:[],
      commercial_theme:"Validação cadastral antes da abordagem",
      discovery_question:"Qual documento mais recente ou fonte primária resolve a divergência identificada?",
      caution:"Não usar o dado divergente em abordagem até resolver a inconsistência."
    });
  }

  for(const row of existing){
    if(row.status!=="ACTIVE"||!managed.has(row.signal_type)||generated.has(row.signal_type))continue;
    const result=await admin.from("commercial_signals").update({status:"STALE",updated_at:new Date().toISOString()}).eq("id",row.id).eq("organization_id",orgId).eq("lead_id",leadId).eq("status","ACTIVE").eq("updated_at",row.updated_at).select("id").maybeSingle();
    if(result.error)throw new Error("Could not retire unsupported automatic signal");
  }
  const {data:signals,error:signalsError}=await admin.from("commercial_signals").select("*").eq("lead_id",leadId).eq("organization_id",orgId).eq("status","ACTIVE").order("created_at");
  if(signalsError)throw new Error("Could not read derived signals");
  return new Response(JSON.stringify({ok:true,signals:signals||[]}),{headers:H});
 }catch{return new Response(JSON.stringify({error:"Could not complete signal derivation"}),{status:500,headers:H});}
});

