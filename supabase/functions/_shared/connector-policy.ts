import { fetchSourceJson } from './source-operations.ts';

export function classifyWebResult(domain: string,url: string,title: string) {
 const belongs=(host:string)=>domain===host||domain.endsWith('.'+host);
 if(belongs('gov.br'))return 'OFFICIAL_GOV';
 if(belongs('linkedin.com'))return 'PROFESSIONAL_PROFILE';
 if(['g1.globo.com','valor.globo.com','estadao.com.br','folha.uol.com.br','exame.com','reuters.com','bloomberg.com'].some(belongs))return 'NEWS_OR_MEDIA';
 if(['facebook.com','instagram.com','tiktok.com','x.com','twitter.com'].some(belongs))return 'WEB_CANDIDATE';
 if(/empresa|institucional|quem somos|about|grupo|holding/i.test(title+' '+url))return 'CORPORATE_CANDIDATE';
 return 'WEB_CANDIDATE';
}

export async function collectSourcePages(endpoint: string, headers: Record<string,string>, maxPages: number, fetcher: typeof fetch=fetch) {
 const rows:any[]=[];
 for(let page=1;page<=maxPages;page++){
  const url=new URL(endpoint);url.searchParams.set('pagina',String(page));
  const result=await fetchSourceJson(url.toString(),v=>Array.isArray(v)||Array.isArray(v?.data),{headers,fetcher});
  if(!result.ok)return {ok:false,complete:false,status:result.status,rows,pages:page-1,error:result.error};
  const batch=Array.isArray(result.data)?result.data:result.data.data;
  rows.push(...batch);
  if(!batch.length)return {ok:true,complete:true,status:result.status,rows,pages:page,error:null};
 }
 return {ok:true,complete:false,status:200,rows,pages:maxPages,error:'PAGE_LIMIT'};
}

// Re-queries never reset review state or move an existing document to a different lead.
export async function insertEvidenceOnce(admin:any,payload:any){
 if(payload.legacy_dedupe_key){
  const legacy=await admin.from('evidence').select('id,verification_status').eq('organization_id',payload.organization_id).eq('lead_id',payload.lead_id).eq('dedupe_key',payload.legacy_dedupe_key).maybeSingle();
  if(legacy.error)throw new Error('Could not load legacy source evidence');
  if(legacy.data)return legacy.data;
 }
 const {legacy_dedupe_key,...record}=payload;
 const {error}=await admin.from('evidence').upsert(record,{onConflict:'organization_id,dedupe_key',ignoreDuplicates:true});
 if(error)throw new Error('Could not persist source evidence');
 const result=await admin.from('evidence').select('id,verification_status').eq('organization_id',payload.organization_id).eq('dedupe_key',payload.dedupe_key).single();
 if(result.error)throw new Error('Could not load source evidence');
 return result.data;
}
