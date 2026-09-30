
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

import { insertEvidenceOnce } from '../_shared/connector-policy.ts';

const JSON_HEADERS = {"Content-Type":"application/json","Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, GET, OPTIONS"};
const cnpjNorm = (v: unknown) => String(v ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const isValidCnpj = (v: unknown) => {
  const c=cnpjNorm(v);
  if(!/^[A-Z0-9]{12}[0-9]{2}$/.test(c)) return false;
  const val=(ch:string)=>ch.charCodeAt(0)-48;
  const calc=(base:string,weights:number[])=>{
    const sum=[...base].reduce((s,ch,i)=>s+val(ch)*weights[i],0);
    const rem=sum%11; return rem<2?0:11-rem;
  };
  const d1=calc(c.slice(0,12),[5,4,3,2,9,8,7,6,5,4,3,2]);
  if(d1!==Number(c[12])) return false;
  const d2=calc(c.slice(0,12)+String(d1),[6,5,4,3,2,9,8,7,6,5,4,3,2]);
  return d2===Number(c[13]);
};
const normalizeName = (v: string) => (v || "").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9 ]/g," ").replace(/\s+/g," ").trim();

Deno.serve(async (req: Request) => {
  if(req.method==="OPTIONS") return new Response("ok",{headers:JSON_HEADERS});
  const started = Date.now();
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "POST required" }), { status: 405, headers: JSON_HEADERS });

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: JSON_HEADERS });

  const url = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const userClient = createClient(url, anonKey, { global: { headers: { Authorization: authHeader } } });
  const admin = createClient(url, serviceKey);

  const { data: { user }, error: userError } = await userClient.auth.getUser();
  if (userError || !user) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: JSON_HEADERS });

  const body = await req.json().catch(() => ({}));
  const leadId = String(body?.lead_id || "");
  const cnpj = cnpjNorm(body?.cnpj);
  if (!leadId || !isValidCnpj(cnpj)) return new Response(JSON.stringify({ error: "lead_id and a valid 14-position CNPJ (numeric or alphanumeric) are required" }), { status: 400, headers: JSON_HEADERS });

  const { data: profile } = await admin.from("profiles").select("active_organization_id").eq("id", user.id).single();
  const orgId = profile?.active_organization_id;
  if (!orgId) return new Response(JSON.stringify({ error: "No active organization" }), { status: 409, headers: JSON_HEADERS });

  const { data: membership } = await admin.from("organization_members").select("role,status").eq("organization_id", orgId).eq("user_id", user.id).maybeSingle();
  if (membership?.status !== "ACTIVE") return new Response(JSON.stringify({ error: "No organization access" }), { status: 403, headers: JSON_HEADERS });
  if (membership.role === "VIEWER") return new Response(JSON.stringify({error:"Viewer is read-only"}),{status:403,headers:JSON_HEADERS});

  const { data: lead } = await admin.from("leads").select("id,name,organization_id").eq("id", leadId).eq("organization_id", orgId).maybeSingle();
  if (!lead) return new Response(JSON.stringify({ error: "Lead not found" }), { status: 404, headers: JSON_HEADERS });

  const { data: source } = await admin.from("source_registry").select("id").eq("key", "brasilapi_cnpj").single();

  let response: Response;
  try {
    response = await fetch(`https://brasilapi.com.br/api/cnpj/v1/${cnpj}`, { headers: { Accept: "application/json" },signal:AbortSignal.timeout(10000) });
  } catch {
    await admin.from("source_fetch_logs").insert({
      organization_id: orgId, source_registry_id: source?.id, success: false,
      endpoint_reference: "brasilapi.com.br/api/cnpj/v1/{cnpj}", result_status: "NETWORK_ERROR",
      error_summary: "BrasilAPI unavailable", duration_ms: Date.now() - started, created_by: user.id
    });
    return new Response(JSON.stringify({ error: "CNPJ source unavailable" }), { status: 502, headers: JSON_HEADERS });
  }

  if (!response.ok) {
    await admin.from("source_fetch_logs").insert({
      organization_id: orgId, source_registry_id: source?.id, success: false,
      endpoint_reference: "brasilapi.com.br/api/cnpj/v1/{cnpj}", http_status: response.status,
      result_status: "UPSTREAM_ERROR", duration_ms: Date.now() - started, created_by: user.id
    });
    return new Response(JSON.stringify({ error: "CNPJ lookup failed", status: response.status }), { status: response.status === 404 ? 404 : 502, headers: JSON_HEADERS });
  }

  const raw = await response.json();
  const qsa = Array.isArray(raw.qsa) ? raw.qsa.map((q: any) => ({
    name: String(q.nome_socio ?? "").replace(/\*+/g,"").trim(),
    role: q.qualificacao_socio ? String(q.qualificacao_socio) : null,
    identifier: Number(q.identificador_de_socio ?? 0) || null,
    partner_document: Number(q.identificador_de_socio ?? 0) === 1 && q.cnpj_cpf_do_socio ? String(q.cnpj_cpf_do_socio) : null,
    partnership_start_date: q.data_entrada_sociedade ? String(q.data_entrada_sociedade) : null,
    age_group: q.faixa_etaria ? String(q.faixa_etaria) : null
  })).filter((q: any) => q.name && !/\d{3}\.?\d{3}\.?\d{3}/.test(q.name)) : [];

  const normalized = {
    cnpj,
    legal_name: raw.razao_social ?? null,
    trade_name: raw.nome_fantasia ?? null,
    registration_status: raw.descricao_situacao_cadastral ?? null,
    status_date: raw.data_situacao_cadastral ?? null,
    headquarters_branch: raw.descricao_identificador_matriz_filial ?? null,
    city: raw.municipio ?? null,
    state: raw.uf ?? null,
    cnae_code: raw.cnae_fiscal ? String(raw.cnae_fiscal) : null,
    cnae_description: raw.cnae_fiscal_descricao ?? null,
    size: raw.porte ?? raw.descricao_porte ?? null,
    capital_social: raw.capital_social == null ? null : Number(raw.capital_social),
    qsa
  };

  const { data: company, error: companyError } = await admin.from("companies").upsert({
    organization_id: orgId, created_by: user.id, cnpj,
    legal_name: normalized.legal_name, trade_name: normalized.trade_name,
    registration_status: normalized.registration_status, status_date: normalized.status_date || null,
    headquarters_branch: normalized.headquarters_branch, city: normalized.city, state: normalized.state,
    cnae_code: normalized.cnae_code, cnae_description: normalized.cnae_description,
    size: normalized.size, capital_social: normalized.capital_social,
    source_label: "BrasilAPI (origem: base pública RFB)",
    source_url: `https://brasilapi.com.br/api/cnpj/v1/${cnpj}`,
    consulted_at: new Date().toISOString()
  }, { onConflict: "organization_id,cnpj" }).select("id").single();

  if (companyError) return new Response(JSON.stringify({ error: "Could not persist company", detail: companyError.message }), { status: 500, headers: JSON_HEADERS });

  const { data: existingLeadCompanyLink } = await admin.from("lead_company_links")
    .select("id,status,role_label")
    .eq("organization_id",orgId).eq("lead_id",leadId).eq("company_id",company.id).maybeSingle();

  if (!existingLeadCompanyLink) {
    await admin.from("lead_company_links").insert({
      organization_id: orgId, lead_id: leadId, company_id: company.id,
      role_label: "Vínculo com o lead a validar", status: "PENDING"
    });
  }
  // Never downgrade an existing VERIFIED/SUPPORTED link during a routine CNPJ refresh.

  const baseEvidenceKey=`brasilapi:cnpj:${leadId}:${cnpj}:${normalized.status_date || "current"}`;
  const {data:legacyReview,error:legacyError}=await admin.from("evidence").select("id,verification_status").eq("organization_id",orgId).eq("lead_id",leadId).eq("dedupe_key",baseEvidenceKey).maybeSingle();
  if(legacyError)return new Response(JSON.stringify({error:"Could not load previous evidence review"}),{status:500,headers:JSON_HEADERS});
  if(legacyReview&&legacyReview.verification_status!=="VERIFIED")return new Response(JSON.stringify({ok:true,status:"REVIEW_REQUIRED",company_id:company.id,evidence_id:legacyReview.id,claim_ids:[],relationship_ids:[],data:{cnpj}}),{headers:JSON_HEADERS});
  const snapshot=JSON.stringify({...normalized,qsa:qsa.map((p:any)=>({name:p.name,role:p.role,identifier:p.identifier,partnership_start_date:p.partnership_start_date})),opening_date:raw.data_inicio_atividade,legal_nature:raw.natureza_juridica,secondary_activities:raw.cnaes_secundarios});
  const fingerprint=[...new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(snapshot)))].map(n=>n.toString(16).padStart(2,"0")).join("");
  const evidencePayload = {
    organization_id: orgId, lead_id: leadId, company_id: company.id, source_registry_id: source?.id,
    title: `Cadastro CNPJ ${cnpj}`,
    source_label: "BrasilAPI CNPJ (origem: base pública RFB)",
    source_url: `https://brasilapi.com.br/api/cnpj/v1/${cnpj}`,
    source_kind: "AGGREGATOR", document_type: "CNPJ_REGISTRY",
    publisher: "BrasilAPI / dados de origem RFB", retrieved_at: new Date().toISOString(),
    dedupe_key: baseEvidenceKey+":"+fingerprint,evidence_hash:fingerprint,
    reliability_weight: 0.75, raw_reference: cnpj,
    excerpt: `Razão social: ${normalized.legal_name ?? "não informada"}; situação: ${normalized.registration_status ?? "não informada"}; município/UF: ${normalized.city ?? "?"}/${normalized.state ?? "?"}; CNAE: ${normalized.cnae_description ?? "não informado"}; QSA: ${qsa.map((x:any)=>x.name + (x.role ? " ("+x.role+")" : "")).join("; ") || "não informado"}.`,
    verification_status: "VERIFIED", last_verified_at: new Date().toISOString(),
    usage_scope: "INTERNAL", created_by: user.id
  };

  let evidence:any;
  try{evidence=await insertEvidenceOnce(admin,evidencePayload)}catch{return new Response(JSON.stringify({error:"Could not persist evidence"}),{status:500,headers:JSON_HEADERS})}
  if(evidence.verification_status!=='VERIFIED')return new Response(JSON.stringify({ok:true,status:"REVIEW_REQUIRED",company_id:company.id,evidence_id:evidence.id,claim_ids:[],relationship_ids:[],data:{cnpj},note:"Existing evidence review preserved; no facts generated"}),{headers:JSON_HEADERS});

  const facts = [
    ["CNPJ_OPENING", normalized.legal_name || cnpj, "opening_date", raw.data_inicio_atividade, raw.data_inicio_atividade],
    ["CNPJ_LEGAL_NATURE", normalized.legal_name || cnpj, "legal_nature", raw.natureza_juridica, null],
    ["CNPJ_SIZE", normalized.legal_name || cnpj, "company_size", normalized.size, null],
    ["CNPJ_BRANCH", normalized.legal_name || cnpj, "headquarters_branch", normalized.headquarters_branch, null],
    ["CNPJ_CAPITAL", normalized.legal_name || cnpj, "registered_capital", normalized.capital_social==null?null:String(normalized.capital_social), null],
    ["CNPJ_SECONDARY_ACTIVITIES", normalized.legal_name || cnpj, "secondary_activities", (raw.cnaes_secundarios||[]).map(x=>x.descricao).filter(Boolean).join("; "), null],
    ["CNPJ_STATUS", normalized.legal_name || cnpj, "registration_status", normalized.registration_status, normalized.status_date],
    ["CNPJ_NAME", normalized.legal_name || cnpj, "legal_name", normalized.legal_name, null],
    ["CNPJ_LOCATION", normalized.legal_name || cnpj, "location", [normalized.city, normalized.state].filter(Boolean).join("/") || null, null],
    ["CNPJ_CNAE", normalized.legal_name || cnpj, "cnae", normalized.cnae_description, null]
  ].filter((x: any[]) => x[3]);

  const claimIds: string[] = [];
  for (const [claim_type, subject_label, predicate, value_text, valid_from] of facts) {
    const { data: existing } = await admin.from("claims")
      .select("id,status").eq("organization_id",orgId).eq("lead_id",leadId).eq("company_id",company.id)
      .eq("claim_type",claim_type).eq("predicate",predicate).eq("value_text",value_text).maybeSingle();

    let claimId = existing?.id as string | undefined;
    if (!claimId) {
      const { data: claim } = await admin.from("claims").insert({
        organization_id: orgId, lead_id: leadId, company_id: company.id,
        claim_type, subject_label, predicate, value_text, valid_from: valid_from || null,
        classification: "FACT", confidence: "HIGH", status: "PENDING", generated_by: "CONNECTOR",
        explanation: "Fato cadastral obtido por agregador da base pública da Receita; não é consulta ao vivo na Receita.",
        created_by: user.id
      }).select("id").single();
      claimId = claim?.id;
    }
    if (claimId) {
      await admin.from("claim_evidence").upsert({
        organization_id: orgId, claim_id: claimId, evidence_id: evidence.id, support_type: "SUPPORTS", strength: 1
      }, { onConflict: "claim_id,evidence_id" });
      await admin.from("claims").update({ status: "VERIFIED" }).eq("id", claimId).not("status","in","(CONTRADICTED,REJECTED)");
      claimIds.push(claimId);
    }
  }

  const relationshipIds: string[] = [];
  const qsaCandidateIds: string[] = [];
  for (const partner of qsa) {
    // Receita/BrasilAPI: identificador 1 = pessoa jurídica, 2 = pessoa física.
    if (partner.identifier === 1) {
      const basicCnpj = cnpjNorm(partner.partner_document).slice(0,8) || null;
      const { data: existingCandidate } = await admin.from("candidate_entities").select("id")
        .eq("organization_id",orgId).eq("lead_id",leadId).eq("candidate_type","QSA_LEGAL_ENTITY")
        .eq("label",partner.name).maybeSingle();
      let candidateId = existingCandidate?.id as string | undefined;
      if (!candidateId) {
        const insertedCandidate = await admin.from("candidate_entities").insert({
          organization_id:orgId,lead_id:leadId,entity_type:"COMPANY",label:partner.name,
          candidate_reason:`Consta no QSA de ${normalized.legal_name || cnpj} como ${partner.role || "sócio pessoa jurídica"}. O CNPJ completo da empresa sócia deve ser resolvido antes de expandir a relação.`,
          candidate_type:"QSA_LEGAL_ENTITY",confidence:"HIGH",validation_status:"UNVALIDATED",
          metadata:{
            source_key:"brasilapi_cnpj",basic_cnpj:basicCnpj,partner_identifier:1,
            partner_role:partner.role,partnership_start_date:partner.partnership_start_date,
            parent_company_id:company.id,parent_company_cnpj:cnpj
          },created_by:user.id
        }).select("id").single();
        candidateId=insertedCandidate.data?.id;
      }
      if (candidateId) qsaCandidateIds.push(candidateId);
      continue;
    }

    if (partner.identifier !== 2) {
      const { data: unknownCandidate } = await admin.from("candidate_entities").insert({
        organization_id:orgId,lead_id:leadId,entity_type:"GROUP",label:partner.name,
        candidate_reason:"Participante do QSA com tipo cadastral não resolvido; não classificado automaticamente como pessoa física.",
        candidate_type:"QSA_UNRESOLVED_ENTITY",confidence:"MEDIUM",validation_status:"UNVALIDATED",
        metadata:{source_key:"brasilapi_cnpj",partner_identifier:partner.identifier,partner_role:partner.role,parent_company_id:company.id},
        created_by:user.id
      }).select("id").single();
      if (unknownCandidate?.id) qsaCandidateIds.push(unknownCandidate.id);
      continue;
    }

    const normalizedPartner = normalizeName(partner.name);
    const context = `QSA:${company.id}`;
    let { data: person } = await admin.from("people").select("id")
      .eq("organization_id",orgId).eq("normalized_name",normalizedPartner).eq("source_context",context).maybeSingle();

    if (!person) {
      const inserted = await admin.from("people").insert({
        organization_id:orgId,display_name:partner.name,normalized_name:normalizedPartner,
        identity_status:"UNRESOLVED",source_context:context,created_by:user.id
      }).select("id").single();
      person = inserted.data;
    }
    if (!person?.id) continue;

    const relType = /administrador|diretor|presidente/i.test(partner.role || "") ? "ADMINISTRADOR" : "SOCIO";
    const { data: existingRel } = await admin.from("relationships").select("id,status")
      .eq("organization_id",orgId).eq("lead_id",leadId).eq("from_entity_type","COMPANY").eq("from_entity_id",company.id)
      .eq("to_entity_type","PERSON").eq("to_entity_id",person.id).eq("relationship_type",relType).maybeSingle();

    let relId = existingRel?.id as string | undefined;
    if (!relId) {
      const insertedRel = await admin.from("relationships").insert({
        organization_id:orgId,lead_id:leadId,
        from_entity_type:"COMPANY",from_entity_id:company.id,from_label:normalized.legal_name || cnpj,
        to_entity_type:"PERSON",to_entity_id:person.id,to_label:partner.name,
        relationship_type:relType,classification:"FACT",confidence:"HIGH",status:"PENDING",
        reason:`Consta no QSA como ${partner.role || "sócio/administrador"} (pessoa física); identidade individual além do registro ainda não resolvida.`,
        created_by:user.id
      }).select("id").single();
      relId = insertedRel.data?.id;
    }
    if (relId) {
      await admin.from("relationship_evidence").upsert({
        organization_id:orgId,relationship_id:relId,evidence_id:evidence.id,support_type:"SUPPORTS",strength:1
      }, { onConflict:"relationship_id,evidence_id" });
      await admin.from("relationships").update({status:"VERIFIED"}).eq("id",relId).not("status","in","(CONTRADICTED,REJECTED)");
      relationshipIds.push(relId);
    }
  }

  const statusUpper = String(normalized.registration_status || "").toUpperCase();
  let eventId: string | null = null;
  if (/(BAIX|INAPT|SUSP|LIQUID|NULA)/.test(statusUpper)) {
    const { data: existingEvent } = await admin.from("events").select("id,status")
      .eq("organization_id",orgId).eq("lead_id",leadId).eq("company_id",company.id)
      .eq("event_type","REGISTRATION_STATUS_CHANGE").eq("event_date",normalized.status_date || null).maybeSingle();

    eventId = existingEvent?.id ?? null;
    if (!eventId) {
      const { data: event } = await admin.from("events").insert({
        organization_id: orgId, lead_id: leadId, company_id: company.id,
        event_type: "REGISTRATION_STATUS_CHANGE", event_date: normalized.status_date || null,
        title: `Situação cadastral: ${normalized.registration_status}`,
        description: "Evento cadastral confirmado. O motivo econômico não está confirmado por esta fonte e deve ser investigado separadamente.",
        classification: "FACT", confidence: "HIGH", status: "PENDING",
        metadata: { investigation_question: "O que explica este evento cadastral?", economic_reason_confirmed: false },
        created_by: user.id
      }).select("id").single();
      eventId = event?.id ?? null;
    }
    if (eventId) {
      await admin.from("event_evidence").upsert({
        organization_id:orgId,event_id:eventId,evidence_id:evidence.id,support_type:"SUPPORTS",strength:1
      }, { onConflict:"event_id,evidence_id" });
      await admin.from("events").update({status:"VERIFIED"}).eq("id",eventId).not("status","in","(CONTRADICTED,REJECTED)");
    }
  }

  await admin.from("source_fetch_logs").insert({
    organization_id: orgId, source_registry_id: source?.id,
    endpoint_reference: "brasilapi.com.br/api/cnpj/v1/{cnpj}",
    success: true, http_status: 200, result_status: "OK",
    duration_ms: Date.now()-started, created_by: user.id
  });

  const safeNormalized = {
    ...normalized,
    qsa: normalized.qsa.map((p:any)=>({
      name:p.name,role:p.role,identifier:p.identifier,
      partnership_start_date:p.partnership_start_date,age_group:p.age_group
    }))
  };

  return new Response(JSON.stringify({
    ok:true,company_id:company.id,evidence_id:evidence.id,
    claim_ids:claimIds,relationship_ids:relationshipIds,qsa_candidate_ids:qsaCandidateIds,event_id:eventId,data:safeNormalized
  }), { headers: JSON_HEADERS });
});
