const normalize=(v:unknown)=>String(v||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
export async function persistCompanyIdentitySupport(admin:any,leadId:string,orgId:string):Promise<'SUPPORTED'|'VERIFIED'>{
 const updated=await admin.from('leads').update({identity_status:'SUPPORTED',updated_at:new Date().toISOString()})
  .eq('id',leadId).eq('organization_id',orgId).eq('kind','COMPANY').neq('identity_status','VERIFIED');
 if(updated.error)throw new Error('Could not persist company identity support');
 const actual=await admin.from('leads').select('id,identity_status').eq('id',leadId).eq('organization_id',orgId).eq('kind','COMPANY').maybeSingle();
 if(actual.error)throw new Error('Could not confirm persisted company identity');
 if(!actual.data||!['SUPPORTED','VERIFIED'].includes(actual.data.identity_status))throw new Error('Company identity support was not persisted');
 return actual.data.identity_status;
}
// A company nucleus with a user-supplied exact CNPJ is a legal entity, not a personal identity.
export async function ensureCompanyResearchLink(admin:any,lead:any,orgId:string,companyId:string,cnpj:string,evidenceId:string){
 const read=()=>admin.from('lead_company_links').select('id,status').eq('organization_id',orgId).eq('lead_id',lead.id).eq('company_id',companyId).maybeSingle();
 const link=await read();if(link.error)throw new Error('Could not validate company attribution');
 if(['SUPPORTED','VERIFIED'].includes(link.data?.status))return true;
 if(link.data?.status!=='PENDING'||lead.kind!=='COMPANY'||normalize(lead.initial_cnpj)!==normalize(cnpj)||!evidenceId)return false;
 const evidence=await admin.from('evidence').select('id,verification_status').eq('organization_id',orgId).eq('lead_id',lead.id).eq('company_id',companyId).eq('id',evidenceId).maybeSingle();
 if(evidence.error)throw new Error('Could not validate company evidence');
 if(evidence.data?.verification_status!=='VERIFIED')return false;
 const updated=await admin.from('lead_company_links').update({status:'SUPPORTED',role_label:'Entidade jurídica deste núcleo; CNPJ exato documentado'}).eq('id',link.data.id).eq('organization_id',orgId).eq('status','PENDING');
 if(updated.error)throw new Error('Could not persist company attribution');
 // A concurrent rejection always wins; no downstream source is started on stale attribution.
 const actual=await read();if(actual.error)throw new Error('Could not confirm company attribution');
 return ['SUPPORTED','VERIFIED'].includes(actual.data?.status);
}
