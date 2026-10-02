import {persistSourceEvidence} from './source-evidence.ts';
import type {FinancialFact} from './cvm-dfp.ts';
export function financialValueText(fact:FinancialFact){
 const amount=Number(fact.amount_brl);
 const value=Number.isFinite(amount)&&Math.abs(amount)<=Number.MAX_SAFE_INTEGER?new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL',minimumFractionDigits:2,maximumFractionDigits:2}).format(amount):`BRL ${fact.amount_brl}`;
 const period=fact.period_start?`${fact.period_start} a ${fact.period_end}`:`posição em ${fact.period_end}`;
 const exact=(fact.amount_brl.split('.')[1]||'').replace(/0+$/,'').length>2?`; valor exato BRL ${fact.amount_brl}`:'';
 return `${value} — ${fact.label}; ${period}; consolidado; DFP v${fact.version}; fonte em ${fact.original_scale}${exact}.`;
}
export async function persistDfpFacts(admin:any,context:{organization_id:string;lead_id:string;company_id:string;source_registry_id:string;created_by:string},result:{cnpj:string;year:number;source_url:string;archive_etag:string;members:string[];facts:FinancialFact[]}){
 if(!result.facts.length)return {evidence_id:null,claim_ids:[],review_required:0};
 const facts=result.facts;
 const evidence=await persistSourceEvidence(admin,{
  ...context,title:`CVM DFP ${result.year} — demonstrações consolidadas — ${facts[0].company_name}`,
  source_label:'CVM — Demonstrações Financeiras Padronizadas (DFP)',source_url:result.source_url,
  source_kind:'PRIMARY_OFFICIAL',document_type:'CVM_DFP_FINANCIAL_STATEMENTS',publisher:'Comissão de Valores Mobiliários — CVM',
  source_date:facts.map(f=>f.period_end).sort().at(-1),retrieved_at:new Date().toISOString(),
  dedupe_key:`${context.lead_id}:cvm_dfp:${result.cnpj}:${result.year}`,reliability_weight:1,
  raw_reference:JSON.stringify({cnpj:result.cnpj,year:result.year,archive_etag:result.archive_etag,members:result.members,facts}),
  excerpt:`CNPJ emissor: ${result.cnpj}. ${facts.map(f=>`${f.predicate}: ${financialValueText(f)} Conta CVM ${f.account_code}.`).join(' ')} Dados consolidados do emissor e suas controladas; não são demonstrações individuais nem posição financeira atual ou patrimônio pessoal.`,
  verification_status:'VERIFIED',last_verified_at:new Date().toISOString(),usage_scope:'INTERNAL'
 });
 if(evidence.error||!evidence.data)throw new Error('Could not persist DFP evidence');
 if(evidence.data.verification_status!=='VERIFIED')return {evidence_id:evidence.data.id,claim_ids:[],review_required:facts.length};
 const claimIds:string[]=[];let reviewRequired=0;
 for(const fact of facts){
  const claimType='CVM_DFP_'+fact.predicate.toUpperCase(),valueText=financialValueText(fact);
  const existing=await admin.from('claims').select('id,status').eq('organization_id',context.organization_id).eq('lead_id',context.lead_id).eq('company_id',context.company_id).eq('claim_type',claimType).eq('predicate',fact.predicate).eq('value_text',valueText).maybeSingle();
  if(existing.error)throw new Error('Could not load DFP fact review');
  if(['REJECTED','CONTRADICTED'].includes(existing.data?.status)){reviewRequired++;continue}
  let id=existing.data?.id;
  if(!id){
   const insert=await admin.from('claims').insert({organization_id:context.organization_id,lead_id:context.lead_id,company_id:context.company_id,claim_type:claimType,subject_label:fact.company_name,predicate:fact.predicate,value_text:valueText,
    value_json:{financial_document:{...fact,source_key:'cvm_dfp',source_url:result.source_url,reference_year:result.year}},
    classification:'FACT',confidence:'HIGH',status:'PENDING',generated_by:'CONNECTOR',valid_from:fact.period_end,valid_to:fact.period_end,
    explanation:'Valor extraído da conta fixa do DFP oficial, com CNPJ, período, escala e versão explícitos. Refere-se ao consolidado do emissor e suas controladas; não determina liquidez atual nem patrimônio pessoal.',created_by:context.created_by
   }).select('id').single();
   if(insert.error||!insert.data?.id)throw new Error('Could not persist DFP fact');id=insert.data.id;
  }
  const support=await admin.from('claim_evidence').upsert({organization_id:context.organization_id,claim_id:id,evidence_id:evidence.data.id,support_type:'SUPPORTS',strength:1},{onConflict:'claim_id,evidence_id'});
  if(support.error)throw new Error('Could not persist DFP fact support');
  const update=await admin.from('claims').update({status:'VERIFIED'}).eq('id',id).eq('organization_id',context.organization_id).not('status','in','(CONTRADICTED,REJECTED)').select('id');
  if(update.error)throw new Error('Could not verify supported DFP fact');
  if(!update.data?.length){reviewRequired++;continue}
  // AFTER triggers may open a contradiction for a restatement of the same period.
  const actual=await admin.from('claims').select('id,status').eq('id',id).eq('organization_id',context.organization_id).maybeSingle();
  if(actual.error||!actual.data)throw new Error('Could not validate persisted DFP fact status');
  if(actual.data.status!=='VERIFIED'){reviewRequired++;continue}claimIds.push(id);
 }
 return {evidence_id:evidence.data.id,claim_ids:claimIds,review_required:reviewRequired};
}
