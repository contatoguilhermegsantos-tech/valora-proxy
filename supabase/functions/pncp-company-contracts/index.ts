import {persistSourceEvidence} from '../_shared/source-evidence.ts';

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const H={"Content-Type":"application/json","Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, GET, OPTIONS"};
const cnpjNorm=(v:unknown)=>String(v??"").toUpperCase().replace(/[^A-Z0-9]/g,"");
const cnpjShape=(v:unknown)=>/^[A-Z0-9]{12}[0-9]{2}$/.test(cnpjNorm(v));

Deno.serve(async(req:Request)=>{
  if(req.method==="OPTIONS") return new Response("ok",{headers:H});
  if(req.method==="OPTIONS") return new Response("ok",{headers:H});
  if(req.method!=="POST") return new Response(JSON.stringify({error:"POST required"}),{status:405,headers:H});
  const auth=req.headers.get("Authorization");
  if(!auth) return new Response(JSON.stringify({error:"Unauthorized"}),{status:401,headers:H});

  const url=Deno.env.get("SUPABASE_URL")!;
  const anon=Deno.env.get("SUPABASE_ANON_KEY")!;
  const service=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const userClient=createClient(url,anon,{global:{headers:{Authorization:auth}}});
  const admin=createClient(url,service);
  const {data:{user}}=await userClient.auth.getUser();
  if(!user) return new Response(JSON.stringify({error:"Unauthorized"}),{status:401,headers:H});

  const body=await req.json().catch(()=>({}));
  const leadId=String(body.lead_id||"");
  const companyId=String(body.company_id||"");
  if(!leadId || !companyId) return new Response(JSON.stringify({error:"lead_id and company_id required"}),{status:400,headers:H});

  const {data:profile}=await admin.from("profiles").select("active_organization_id").eq("id",user.id).single();
  const orgId=profile?.active_organization_id;
  if(!orgId) return new Response(JSON.stringify({error:"No active organization"}),{status:409,headers:H});
  const {data:membership}=await admin.from('organization_members').select('role,status').eq('organization_id',orgId).eq('user_id',user.id).maybeSingle();
  if(membership?.status!=='ACTIVE'||membership.role==='VIEWER')return new Response(JSON.stringify({error:'Write access required'}),{status:403,headers:H});

  const {data:company}=await admin.from("companies").select("*").eq("id",companyId).eq("organization_id",orgId).maybeSingle();
  const {data:lead}=await admin.from("leads").select("id,name").eq("id",leadId).eq("organization_id",orgId).maybeSingle();
  if(!company || !lead) return new Response(JSON.stringify({error:"Lead or company not found"}),{status:404,headers:H});
  const {data:companyLink,error:linkError}=await admin.from('lead_company_links').select('status').eq('organization_id',orgId).eq('lead_id',leadId).eq('company_id',companyId).maybeSingle();
  if(linkError)return new Response(JSON.stringify({error:'Could not validate company context'}),{status:500,headers:H});
  if(!companyLink||!['SUPPORTED','VERIFIED'].includes(companyLink.status))return new Response(JSON.stringify({error:'Company attribution requires validation in this lead'}),{status:409,headers:H});
  const cnpj=cnpjNorm(company.cnpj);
  if(!cnpjShape(cnpj)) return new Response(JSON.stringify({error:"Company has no valid numeric/alphanumeric CNPJ"}),{status:400,headers:H});

  const {data:source}=await admin.from("source_registry").select("id").eq("key","pncp").single();
  const {data:sync}=await admin.from("source_sync_state").select("*").eq("source_key","pncp").maybeSingle();

  const {data:contracts,error:contractError}=await admin.from("public_contract_index")
    .select("*").eq("supplier_cnpj",cnpj).order("pncp_publication_date",{ascending:false}).limit(200);
  if(contractError) return new Response(JSON.stringify({error:contractError.message}),{status:500,headers:H});

  const evidenceIds:string[]=[];
  const claimIds:string[]=[];
  const eventIds:string[]=[];
  const relationshipIds:string[]=[];

  for(const c of contracts||[]){
    const amount=c.global_value ?? c.initial_value ?? null;
    const evPayload={
      organization_id:orgId,lead_id:leadId,company_id:companyId,source_registry_id:source?.id,
      title:`Contrato público PNCP ${c.contract_number || c.pncp_control_number}`,
      source_label:"Portal Nacional de Contratações Públicas (PNCP)",
      source_url:c.source_url,
      source_kind:"PRIMARY_OFFICIAL",document_type:"PUBLIC_CONTRACT",
      publisher:"PNCP",
      source_date:c.pncp_publication_date ? String(c.pncp_publication_date).slice(0,10) : c.signature_date,
      retrieved_at:new Date().toISOString(),
      dedupe_key:`${leadId}:pncp:contract:${c.pncp_control_number}`,
      reliability_weight:1,
      raw_reference:c.pncp_control_number,
      excerpt:`Fornecedor: ${c.supplier_name||cnpj}; órgão: ${c.public_body_name||c.public_body_cnpj||"não informado"}; objeto: ${c.object_text||"não informado"}; valor global: ${amount==null?"não informado":amount}; vigência: ${c.validity_start||"?"} a ${c.validity_end||"?"}.`,
      verification_status:"VERIFIED",last_verified_at:new Date().toISOString(),
      usage_scope:"INTERNAL",created_by:user.id
    };
    const {data:ev}=await persistSourceEvidence(admin,evPayload);
    if(!ev?.id)return new Response(JSON.stringify({error:"Evidence persistence failed"}),{status:500,headers:H});
    if(ev.verification_status!=='VERIFIED')continue;
    evidenceIds.push(ev.id);

    let {data:claim}=await admin.from("claims").select("id,status")
      .eq("organization_id",orgId).eq("lead_id",leadId).eq("company_id",companyId)
      .eq("claim_type","PUBLIC_CONTRACT").eq("value_text",c.pncp_control_number).maybeSingle();
    if(!claim){
      const ins=await admin.from("claims").insert({
        organization_id:orgId,lead_id:leadId,company_id:companyId,
        claim_type:"PUBLIC_CONTRACT",subject_label:company.legal_name||company.cnpj,
        predicate:"has_public_contract",value_text:c.pncp_control_number,
        value_json:{public_body:c.public_body_name,global_value:amount,validity_end:c.validity_end,object:c.object_text},
        classification:"FACT",confidence:"HIGH",status:"PENDING",generated_by:"CONNECTOR",
        explanation:"Contrato publicado no PNCP. Valor contratual não comprova pagamento, margem, caixa ou liquidez pessoal.",
        valid_from:c.signature_date||c.validity_start||null,valid_to:c.validity_end||null,created_by:user.id
      }).select("id").single();
      claim=ins.data;
    }
    if(claim?.id){
      await admin.from("claim_evidence").upsert({organization_id:orgId,claim_id:claim.id,evidence_id:ev.id,support_type:"SUPPORTS",strength:1},{onConflict:"claim_id,evidence_id"});
      await admin.from("claims").update({status:"VERIFIED"}).eq("id",claim.id).not("status","in","(CONTRADICTED,REJECTED)");
      claimIds.push(claim.id);
    }

    let {data:event}=await admin.from("events").select("id,status")
      .eq("organization_id",orgId).eq("lead_id",leadId).eq("company_id",companyId)
      .eq("event_type","PUBLIC_CONTRACT").eq("title",`Contrato público PNCP ${c.contract_number || c.pncp_control_number}`).maybeSingle();
    if(!event){
      const ins=await admin.from("events").insert({
        organization_id:orgId,lead_id:leadId,company_id:companyId,event_type:"PUBLIC_CONTRACT",
        event_date:c.signature_date|| (c.pncp_publication_date?String(c.pncp_publication_date).slice(0,10):null),
        title:`Contrato público PNCP ${c.contract_number || c.pncp_control_number}`,
        description:`${c.public_body_name||"Órgão público"} · ${c.object_text||"objeto não informado"}`,
        classification:"FACT",confidence:"HIGH",status:"PENDING",
        metadata:{pncp_control_number:c.pncp_control_number,global_value:amount,validity_start:c.validity_start,validity_end:c.validity_end},
        created_by:user.id
      }).select("id").single();
      event=ins.data;
    }
    if(event?.id){
      await admin.from("event_evidence").upsert({organization_id:orgId,event_id:event.id,evidence_id:ev.id,support_type:"SUPPORTS",strength:1},{onConflict:"event_id,evidence_id"});
      await admin.from("events").update({status:"VERIFIED"}).eq("id",event.id).not("status","in","(CONTRADICTED,REJECTED)");
      eventIds.push(event.id);
    }

    const bodyLabel=c.public_body_name||c.public_body_cnpj||"Órgão público";
    let {data:rel}=await admin.from("relationships").select("id,status")
      .eq("organization_id",orgId).eq("lead_id",leadId)
      .eq("from_entity_type","COMPANY").eq("from_entity_id",companyId)
      .eq("to_entity_type","PUBLIC_BODY").eq("to_label",bodyLabel)
      .eq("relationship_type","CONTRATADA_POR").maybeSingle();
    if(!rel){
      const ins=await admin.from("relationships").insert({
        organization_id:orgId,lead_id:leadId,from_entity_type:"COMPANY",from_entity_id:companyId,
        from_label:company.legal_name||company.cnpj,to_entity_type:"PUBLIC_BODY",to_label:bodyLabel,
        relationship_type:"CONTRATADA_POR",classification:"FACT",confidence:"HIGH",status:"PENDING",
        reason:"Contrato público encontrado no PNCP.",valid_from:c.validity_start||c.signature_date||null,valid_to:c.validity_end||null,created_by:user.id
      }).select("id").single();
      rel=ins.data;
    }
    if(rel?.id){
      await admin.from("relationship_evidence").upsert({organization_id:orgId,relationship_id:rel.id,evidence_id:ev.id,support_type:"SUPPORTS",strength:1},{onConflict:"relationship_id,evidence_id"});
      await admin.from("relationships").update({status:"VERIFIED"}).eq("id",rel.id).not("status","in","(CONTRADICTED,REJECTED)");
      relationshipIds.push(rel.id);
    }
  }

  const today=new Date().toISOString().slice(0,10);
  const active=(contracts||[]).filter((c:any)=>!c.validity_end || String(c.validity_end)>=today);
  const values=(contracts||[]).map((c:any)=>Number(c.global_value ?? c.initial_value ?? 0)).filter((n:number)=>Number.isFinite(n)&&n>0);
  const totalValue=values.reduce((a:number,b:number)=>a+b,0);

  if((contracts||[]).length>=2){
    const confidence=(contracts||[]).length>=5 && active.length>=2 ? "HIGH" : "MEDIUM";
    const summary=`${(contracts||[]).length} contrato(s) público(s) encontrados na cobertura atualmente indexada do PNCP, ${active.length} com vigência não encerrada pela data registrada. Soma de valores contratuais disponíveis: R$ ${totalValue.toLocaleString("pt-BR",{minimumFractionDigits:2,maximumFractionDigits:2})}. Isso não comprova pagamento, receita recorrente efetiva ou liquidez do sócio.`;
    const {data:existingSignal}=await admin.from("commercial_signals").select("id").eq("organization_id",orgId).eq("lead_id",leadId).eq("signal_type","PUBLIC_CONTRACT_PATTERN").eq("status","ACTIVE").maybeSingle();
    const signalPayload={
      organization_id:orgId,lead_id:leadId,signal_type:"PUBLIC_CONTRACT_PATTERN",
      title:"Padrão de contratos públicos identificado",summary,classification:"INDICATION",confidence,status:"ACTIVE",
      evidence_ids:[...new Set(evidenceIds)],claim_ids:[...new Set(claimIds)],event_ids:[...new Set(eventIds)],
      commercial_theme:"Gestão de caixa empresarial, investimentos PJ, planejamento tributário e patrimonial",
      discovery_question:"Qual parcela da receita da empresa vem de contratos públicos e como os recebimentos e reservas de caixa são administrados?",
      caution:"Contrato assinado/publicado não comprova pagamento, margem, adimplência, caixa disponível nem patrimônio ou liquidez pessoal.",
      created_by:user.id,updated_at:new Date().toISOString()
    };
    if(existingSignal?.id) await admin.from("commercial_signals").update(signalPayload).eq("id",existingSignal.id);
    else await admin.from("commercial_signals").insert(signalPayload);
  }

  const {data:coverage}=await admin.from("public_contract_index").select("pncp_publication_date").order("pncp_publication_date",{ascending:true}).limit(1);
  const oldest=coverage?.[0]?.pncp_publication_date ?? null;

  return new Response(JSON.stringify({
    ok:true,company_id:companyId,contracts_found:(contracts||[]).length,active_contracts:active.length,
    indexed_contract_value_sum:totalValue,evidence_created:evidenceIds.length,
    index_coverage:{oldest_publication:oldest,last_sync:sync?.last_successful_date||null,last_status:sync?.last_status||null},
    caution:"A ausência de contratos significa apenas ausência na cobertura indexada atual; não prova que a empresa nunca contratou com o poder público."
  }),{headers:H});
});

