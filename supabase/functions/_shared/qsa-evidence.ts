import {isValidCompanyCnpj} from './company-name-discovery.ts';
export const qsaNameKey=(value:unknown)=>String(value??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().replace(/[^A-Z0-9 ]/g,' ').replace(/ +/g,' ').trim();
// A score consumes the exact cited occurrence, never a newer document found by name.
export function validQsaDiscoveryEvidence(candidate:any,lead:any,evidence:any,sourceKey:string){
 const md=candidate?.metadata||{};
 if(lead?.kind!=='PERSON'||candidate?.entity_type!=='COMPANY'||candidate?.candidate_type!=='RFB_QSA_NAME_MATCH'
  ||candidate.organization_id!==lead.organization_id||candidate.lead_id!==lead.id||!isValidCompanyCnpj(md.full_cnpj)
  ||md.basic_cnpj!==md.full_cnpj.slice(0,8)||qsaNameKey(md.partner_name).length<3||qsaNameKey(md.partner_name)!==qsaNameKey(lead.name)
  ||!evidence||evidence.id!==md.evidence_id||evidence.organization_id!==lead.organization_id||evidence.lead_id!==lead.id
  ||evidence.verification_status!=='VERIFIED'||evidence.document_type!=='RFB_QSA_NAME_DISCOVERY'||sourceKey!=='base_empresarial_rfb'
  ||evidence.source_url!==`https://baseempresarial.com.br/empresa/${md.full_cnpj}`)return false;
 let raw:any;try{raw=JSON.parse(evidence.raw_reference)}catch{return evidence.raw_reference===`partner_name=${md.partner_name}; basic_cnpj=${md.basic_cnpj}`;}
 return !!raw&&typeof raw==='object'&&!Array.isArray(raw)&&String(raw.schema_version)==='2'&&raw.full_cnpj===md.full_cnpj&&raw.basic_cnpj===md.basic_cnpj
  &&qsaNameKey(raw.partner_name)===qsaNameKey(md.partner_name)&&qsaNameKey(raw.query_name)===qsaNameKey(md.partner_name)
  &&!!qsaNameKey(raw.company_name)&&qsaNameKey(raw.company_name)===qsaNameKey(md.company_name);
}
