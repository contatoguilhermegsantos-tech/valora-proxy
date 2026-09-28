
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const H={"Content-Type":"application/json","Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS"};
const cnpjNorm=(v:unknown)=>String(v??"").toUpperCase().replace(/[^A-Z0-9]/g,"");
const cnpjShape=(v:unknown)=>/^[A-Z0-9]{12}[0-9]{2}$/.test(cnpjNorm(v));
const fmt=(v:string)=>{const d=cnpjNorm(v);return cnpjShape(d)?`${d.slice(0,2)}.${d.slice(2,5)}.${d.slice(5,8)}/${d.slice(8,12)}-${d.slice(12)}`:d};
const money=(v:any)=>{const n=Number(v);return Number.isFinite(n)?n:null};

const RESOURCES=[
  {id:"612faa0b-b6be-4b2c-9317-da5dc2c0b901",kind:"INDIRECT_AUTOMATIC",cnpjField:"cpf_cnpj",page:"https://dadosabertos.bndes.gov.br/dataset/operacoes-financiamento/resource/612faa0b-b6be-4b2c-9317-da5dc2c0b901"},
  {id:"6f56b78c-510f-44b6-8274-78a5b7e931f4",kind:"NON_AUTOMATIC",cnpjField:"cnpj",page:"https://dadosabertos.bndes.gov.br/dataset/operacoes-financiamento/resource/6f56b78c-510f-44b6-8274-78a5b7e931f4"}
];

Deno.serve(async(req:Request)=>{
  if(req.method==="OPTIONS") return new Response("ok",{headers:H});
  if(req.method!=="POST") return new Response(JSON.stringify({error:"POST required"}),{status:405,headers:H});
  const auth=req.headers.get("Authorization");
  if(!auth) return new Response(JSON.stringify({error:"Unauthorized"}),{status:401,headers:H});

  const url=Deno.env.get("SUPABASE_URL")!,anon=Deno.env.get("SUPABASE_ANON_KEY")!,service=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const uc=createClient(url,anon,{global:{headers:{Authorization:auth}}});
  const admin=createClient(url,service);
  const {data:{user}}=await uc.auth.getUser();
  if(!user) return new Response(JSON.stringify({error:"Unauthorized"}),{status:401,headers:H});

  const b=await req.json().catch(()=>({}));
  const leadId=String(b.lead_id||"");
  const companyId=String(b.company_id||"");
  if(!leadId||!companyId) return new Response(JSON.stringify({error:"lead_id and company_id required"}),{status:400,headers:H});

  const {data:p}=await admin.from("profiles").select("active_organization_id").eq("id",user.id).single();
  const orgId=p?.active_organization_id;
  if(!orgId) return new Response(JSON.stringify({error:"No active organization"}),{status:409,headers:H});

  const {data:lead}=await admin.from("leads").select("id").eq("id",leadId).eq("organization_id",orgId).maybeSingle();
  const {data:company}=await admin.from("companies").select("id,cnpj,legal_name,trade_name").eq("id",companyId).eq("organization_id",orgId).maybeSingle();
  if(!lead||!company) return new Response(JSON.stringify({error:"Lead or company not found"}),{status:404,headers:H});

  const cnpj=cnpjNorm(company.cnpj);
  if(!cnpjShape(cnpj)) return new Response(JSON.stringify({error:"Company has no valid numeric/alphanumeric CNPJ"}),{status:400,headers:H});

  const {data:sourceRow}=await admin.from("source_registry").select("id").eq("key","bndes_financing").single();
  const started=Date.now();
  const all:any[]=[];

  for(const res of RESOURCES){
    let records:any[]=[];
    for(const candidate of [cnpj,fmt(cnpj)]){
      const endpoint="https://dadosabertos.bndes.gov.br/api/3/action/datastore_search";
      try{
        const rr=await fetch(endpoint,{
          method:"POST",
          headers:{"Content-Type":"application/json",Accept:"application/json","User-Agent":"MAX-Intelligence/1.0"},
          body:JSON.stringify({resource_id:res.id,limit:100,filters:{[res.cnpjField]:candidate}})
        });
        if(!rr.ok) continue;
        const jj=await rr.json();
        const got=Array.isArray(jj?.result?.records)?jj.result.records:[];
        if(got.length){records=got;break}
      }catch{}
    }
    for(const rec of records) all.push({...rec,__resource:res});
  }

  const persisted:any[]=[];
  for(const rec of all){
    const res=rec.__resource;
    const date=String(rec.data_da_contratacao||"").slice(0,10)||null;
    const contract=String(rec.numero_do_contrato||rec.numero_contrato||"").trim();
    const product=String(rec.produto||rec.instrumento_financeiro||"Financiamento").trim();
    const contracted=money(rec.valor_contratado_reais??rec.valor_da_operacao_em_reais);
    const disbursed=money(rec.valor_desembolsado_reais);
    const project=String(rec.descricao_do_projeto||"").trim();
    const situation=String(rec.situacao_do_contrato||rec.situacao_da_operacao||"").trim();
    const dedupeBase=[res.id,cnpj,contract,date,contracted,disbursed,product].join("|");
    const digest=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(dedupeBase)))).map(x=>x.toString(16).padStart(2,"0")).join("");
    const excerpt=[
      `Cliente: ${rec.cliente||company.legal_name||cnpj}`,
      date?`contratação: ${date}`:null,
      product?`produto/instrumento: ${product}`:null,
      contracted!=null?`valor contratado/operação: R$ ${contracted.toLocaleString("pt-BR",{minimumFractionDigits:2,maximumFractionDigits:2})}`:null,
      disbursed!=null?`valor desembolsado: R$ ${disbursed.toLocaleString("pt-BR",{minimumFractionDigits:2,maximumFractionDigits:2})}`:null,
      rec.juros!=null?`juros informados: ${rec.juros}`:null,
      rec.prazo_carencia_meses!=null?`carência: ${rec.prazo_carencia_meses} meses`:null,
      rec.prazo_amortizacao_meses!=null?`amortização: ${rec.prazo_amortizacao_meses} meses`:null,
      situation?`situação: ${situation}`:null,
      project?`projeto: ${project}`:null
    ].filter(Boolean).join("; ")+".";

    const {data:ev,error:evErr}=await admin.from("evidence").upsert({
      organization_id:orgId,lead_id:leadId,company_id:companyId,source_registry_id:sourceRow?.id,
      title:`Operação de financiamento BNDES — ${product}`,
      source_label:"BNDES — Operações de Financiamento",
      source_url:res.page,
      source_kind:"PRIMARY_OFFICIAL",
      document_type:"BNDES_FINANCING_OPERATION",
      publisher:"Banco Nacional de Desenvolvimento Econômico e Social — BNDES",
      source_date:date,
      retrieved_at:new Date().toISOString(),
      evidence_hash:digest,dedupe_key:`${leadId}:bndes:${digest}`,
      reliability_weight:1,
      raw_reference:contract?`contrato=${contract}; resource=${res.id}`:`resource=${res.id}`,
      excerpt,
      verification_status:"VERIFIED",
      last_verified_at:new Date().toISOString(),
      usage_scope:"INTERNAL",
      created_by:user.id
    },{onConflict:"organization_id,dedupe_key"}).select("id").single();
    if(evErr||!ev) continue;

    const eventKey=`bndes:${digest}`;
    let {data:event}=await admin.from("events").select("id,status")
      .eq("organization_id",orgId).eq("lead_id",leadId).eq("company_id",companyId)
      .eq("event_type","BNDES_FINANCING").contains("metadata",{source_dedupe_key:eventKey}).maybeSingle();

    if(!event){
      const inserted=await admin.from("events").insert({
        organization_id:orgId,lead_id:leadId,company_id:companyId,
        event_type:"BNDES_FINANCING",event_date:date,
        title:`Financiamento BNDES — ${product}`,
        description:"Operação de financiamento divulgada no portal de dados abertos do BNDES. Os valores publicados não representam saldo devedor atual, patrimônio ou liquidez pessoal dos sócios.",
        classification:"FACT",confidence:"HIGH",status:"PENDING",
        metadata:{
          source_dedupe_key:eventKey,resource_kind:res.kind,contract_number:contract||null,
          contracted_value:contracted,disbursed_value:disbursed,product:rec.produto||null,
          financial_instrument:rec.instrumento_financeiro||null,cost:rec.custo_financeiro||null,
          interest:rec.juros??null,grace_months:rec.prazo_carencia_meses??null,
          amortization_months:rec.prazo_amortizacao_meses??null,project:project||null,
          current_outstanding_balance_confirmed:false,personal_liquidity_inference_allowed:false
        },
        created_by:user.id
      }).select("id,status").single();
      event=inserted.data;
    }
    if(event?.id){
      await admin.from("event_evidence").upsert({
        organization_id:orgId,event_id:event.id,evidence_id:ev.id,support_type:"SUPPORTS",strength:1
      },{onConflict:"event_id,evidence_id"});
      await admin.from("events").update({status:"VERIFIED"}).eq("id",event.id).neq("status","CONTRADICTED");
    }
    persisted.push({evidence_id:ev.id,event_id:event?.id||null,date,product,contracted_value:contracted,disbursed_value:disbursed,situation});
  }

  await admin.from("source_fetch_logs").insert({
    organization_id:orgId,source_registry_id:sourceRow?.id,
    endpoint_reference:"dadosabertos.bndes.gov.br/api/3/action/datastore_search",
    success:true,http_status:200,result_status:persisted.length?"OPERATIONS_FOUND":"NO_OPERATIONS",
    duration_ms:Date.now()-started,created_by:user.id
  });

  if(persisted.length){
    const {data:q}=await admin.from("investigation_questions").select("id")
      .eq("organization_id",orgId).eq("lead_id",leadId).eq("question_type","BNDES_CAPITAL_STRUCTURE").eq("status","OPEN").maybeSingle();
    if(!q) await admin.from("investigation_questions").insert({
      organization_id:orgId,lead_id:leadId,company_id:companyId,question_type:"BNDES_CAPITAL_STRUCTURE",
      question:"Como esta operação do BNDES se encaixa hoje na estrutura de capital da empresa? Qual é o saldo atual, cronograma de amortização, custo efetivo e necessidade futura de caixa/crédito?",
      status:"OPEN",created_by:user.id
    });
  }

  return new Response(JSON.stringify({
    ok:true,cnpj,operations_found:persisted.length,operations:persisted,
    caveat:"Operação publicada pelo BNDES confirma o financiamento divulgado, mas não o saldo devedor atual, caixa livre da empresa, patrimônio ou liquidez pessoal dos sócios."
  }),{headers:H});
});


