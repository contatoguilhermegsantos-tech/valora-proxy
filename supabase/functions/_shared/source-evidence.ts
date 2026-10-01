import {insertEvidenceOnce} from './connector-policy.ts';
// Bind each revision to its own immutable excerpt. A reviewed legacy document remains blocked.
export async function persistSourceEvidence(admin:any,payload:any){
 const legacy=await admin.from('evidence').select('id,verification_status').eq('organization_id',payload.organization_id).eq('lead_id',payload.lead_id).eq('dedupe_key',payload.dedupe_key).maybeSingle();
 if(legacy.error)return {data:null,error:{message:'Could not load evidence review'}};
 if(legacy.data&&legacy.data.verification_status!=='VERIFIED')return {data:legacy.data,error:null};
 const bytes=new TextEncoder().encode(JSON.stringify([payload.title,payload.excerpt,payload.source_url,payload.source_date,payload.company_id]));
 const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(n=>n.toString(16).padStart(2,'0')).join('');
 try{const data=await insertEvidenceOnce(admin,{...payload,dedupe_key:payload.dedupe_key+':'+hash,evidence_hash:hash});return {data,error:null};}catch{return {data:null,error:{message:'Could not persist immutable source document'}};}
}
