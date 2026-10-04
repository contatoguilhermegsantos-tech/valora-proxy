// Project only reviewed, scoped source observations. Internal search state stays server-side.
import {familyNetworkText} from './family-network-text.ts';
export function projectFamilyNetwork(graph:any,candidates:any[],evidence:any[],organizationId:string,leadId:string){
 if(!graph||!Array.isArray(graph.nodes)||!Array.isArray(graph.edges))return null;
 const documents=new Set(evidence.filter(e=>e.organization_id===organizationId&&e.lead_id===leadId&&e.verification_status==='VERIFIED'&&e.source_registry_id).map(e=>e.id));
 const accepted=new Map(candidates.filter(c=>c.organization_id===organizationId&&c.lead_id===leadId&&['FAMILY_NETWORK_COMPANY','FAMILY_NETWORK_PERSON'].includes(c.candidate_type)&&c.validation_status==='UNVALIDATED'&&c.confidence==='LOW'&&c.metadata?.kinship_confirmed===false&&c.metadata?.identity_confirmed===false&&documents.has(c.metadata?.evidence_id)).map(c=>[c.id,c]));
 const displayFields=new Set(['label','person_name','city','state','cnae_description','trade_name','registration_status','role']);
 const pick=(value:any,fields:string[])=>Object.fromEntries(fields.filter(k=>value[k]!==undefined).map(k=>[k,displayFields.has(k)?familyNetworkText(value[k],300):value[k]]));
 let nodes=graph.nodes.slice(0,281).filter((n:any)=>{
  if(!n||n.identity_confirmed!==false||n.kinship_confirmed!==false)return false;
  if(n.key==='root'&&n.type==='ROOT')return true;
  const c:any=accepted.get(n.candidate_id);return c&&n.key===c.metadata.network_node_key&&n.evidence_id===c.metadata.evidence_id&&n.full_cnpj===c.metadata.full_cnpj&&n.type===(c.candidate_type==='FAMILY_NETWORK_COMPANY'?'COMPANY':'PERSON_CITATION');
 }).map((n:any)=>pick(n,['key','type','label','full_cnpj','person_name','depth','candidate_id','evidence_id','identity_confirmed','kinship_confirmed',...(n.type==='COMPANY'?['city','state','cnae_code','cnae_description','trade_name','registration_status']:[])]));
 if(nodes.filter((n:any)=>n.key==='root'&&n.type==='ROOT').length!==1||new Set(nodes.map((n:any)=>n.key)).size!==nodes.length)return null;
 const keys=new Set(nodes.map((n:any)=>n.key));
 let edges=graph.edges.slice(0,400).filter((e:any)=>e&&['QSA_PARTICIPATION','SAME_NAME_CANDIDATE','SURNAME_CONTEXT_CANDIDATE','ROOT_CONTEXT_CANDIDATE'].includes(e.kind)&&keys.has(e.from)&&keys.has(e.to)&&e.confidence==='LOW'&&e.validation_status==='UNVALIDATED'&&e.identity_confirmed===false&&e.kinship_confirmed===false&&Array.isArray(e.evidence_ids)&&e.evidence_ids.length&&e.evidence_ids.every((id:any)=>documents.has(id))).map((e:any)=>pick(e,['id','from','to','kind','match_basis','role','confidence','validation_status','evidence_id','evidence_ids','identity_confirmed','kinship_confirmed']));
 const reached=new Set(['root']);for(let pass=0;pass<nodes.length;pass++){const before=reached.size;for(const edge of edges){if(reached.has(edge.from))reached.add(edge.to);if(reached.has(edge.to))reached.add(edge.from)}if(reached.size===before)break}
 nodes=nodes.filter((n:any)=>reached.has(n.key));edges=edges.filter((e:any)=>reached.has(e.from)&&reached.has(e.to));
 const allowed=['status','complete','continuation','revision','notes','retry_not_before','pagination_stalled','scanned_count','pages_scanned','counts','search_lineage','last_queried_at','identity_confirmed','kinship_confirmed'];
 const projected:any=Object.fromEntries(allowed.filter(k=>graph[k]!==undefined).map(k=>[k,graph[k]]));
 return {...projected,complete:false,identity_confirmed:false,kinship_confirmed:false,nodes,edges,counts:{companies:nodes.filter((n:any)=>n.type==='COMPANY').length,people:nodes.filter((n:any)=>n.type==='PERSON_CITATION').length,edges:edges.length}};
}
