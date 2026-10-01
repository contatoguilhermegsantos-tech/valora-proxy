const norm=(v:unknown)=>String(v??'').toUpperCase().replace(/[^A-Z0-9]/g,'');
export const canonicalRegistryText=(v:unknown)=>v==null?null:String(v).trim().replace(/\s+/g,' ').toUpperCase();
const name=(v:unknown)=>String(v??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().replace(/[^A-Z0-9 ]/g,' ').replace(/\s+/g,' ').trim();
export function validateQsaMapping(parent:any,target:any,cnpj:string,candidate:any){
 const md=candidate.metadata||{},normalized=normalizeBaseCompany(target,cnpj);
 if(!normalized||cnpj.slice(0,8)!==md.basic_cnpj||name(normalized.razao_social)!==name(candidate.label))return false;
 const p=parent?.data;
 if(norm(p?.basic_cnpj)!==norm(md.parent_company_cnpj).slice(0,8)||!p?.establishments?.some((e:any)=>norm(e.full_cnpj)===norm(md.parent_company_cnpj)))return false;
 return (p.partners||[]).some((s:any)=>Number(s.partner_identifier?.code)===1&&name(s.partner_name)===name(candidate.label)&&(!norm(s.cnpj_cpf_partner)||norm(s.cnpj_cpf_partner).slice(0,8)===md.basic_cnpj));
}
// Explicitly select the requested establishment. A matching root never proves the branch.
// Personal identifiers and representative documents are never copied into the normalized response.
export function normalizeBaseCompany(value:any,cnpj:string){
 const d=value?.data,est=d?.establishments?.find((e:any)=>norm(e.full_cnpj)===cnpj);
 if(!d||norm(d.basic_cnpj)!==cnpj.slice(0,8)||!est||!Array.isArray(d.partners)||typeof d.corporate_name!=='string'||!d.corporate_name.trim())return null;
 const cnae=est.main_cnae;
 return {cnpj,razao_social:d.corporate_name,nome_fantasia:est.trade_name,descricao_situacao_cadastral:est.registration_status?.name,data_situacao_cadastral:est.registration_status_date,descricao_identificador_matriz_filial:est.main_branch_office?.name,municipio:est.address?.city?.name,uf:est.address?.state?.abbreviation,cnae_fiscal:typeof cnae==='object'?cnae?.code:cnae,cnae_fiscal_descricao:typeof cnae==='object'?cnae?.name:null,porte:d.company_size?.name,capital_social:d.equity_capital,data_inicio_atividade:est.activity_start_date,natureza_juridica:d.legal_nature?.name||null,cnaes_secundarios:(est.secondary_cnaes||[]).map((a:any)=>({codigo:a.code,descricao:a.name})),qsa:d.partners.map((p:any)=>({nome_socio:p.partner_name,qualificacao_socio:p.role||p.partner_qualification?.name,identificador_de_socio:Number(p.partner_identifier?.code)||0,cnpj_cpf_do_socio:Number(p.partner_identifier?.code)===1?p.cnpj_cpf_partner:null,data_entrada_sociedade:p.partnership_start_date,faixa_etaria:p.age_group?.name}))};
}
