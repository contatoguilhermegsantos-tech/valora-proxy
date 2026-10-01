type Row = Record<string, any>;
export type HistoryItem = {key:string; kind:'FACT'|'RELATIONSHIP'|'EVENT'; label:string; value:string; evidenceIds:string[]};
export type IntelligenceSnapshot = {version:1; identity:string; items:HistoryItem[]; gaps:{source:string;status:string}[]; sources:{id:string;title:string;url:string|null;date:string|null}[]};
export function buildIntelligenceSnapshot(d:Row):IntelligenceSnapshot {
 const verified=new Set<string>((d.evidence||[]).filter((e:Row)=>e.verification_status==='VERIFIED').map((e:Row)=>e.id));
 const refs=(r:Row,k:string):string[]=>[...new Set<string>((r[k]||[]).filter((x:Row)=>(!x.support_type||x.support_type==='SUPPORTS')&&verified.has(x.evidence_id)).map((x:Row)=>x.evidence_id))].sort();
 const valid=(r:Row,k:string)=>r.status==='VERIFIED'&&r.classification==='FACT'&&refs(r,k).length&&!(r[k]||[]).some((x:Row)=>x.support_type==='CONTRADICTS'&&verified.has(x.evidence_id));
 const rejected=new Set((d.companies||[]).filter((c:Row)=>c.link_status==='REJECTED').map((c:Row)=>c.id));
 const items:HistoryItem[]=[];
 for(const r of d.claims||[])if(valid(r,'claim_evidence')&&!rejected.has(r.company_id))items.push({key:JSON.stringify(['FACT',r.company_id||r.subject_entity_id||r.subject_label,r.predicate]),kind:'FACT',label:`${r.subject_label||'Empresa'} · ${r.predicate}`,value:String(r.value_text??JSON.stringify(r.value_json??null)),evidenceIds:refs(r,'claim_evidence')});
 for(const r of d.relationships||[])if(valid(r,'relationship_evidence')&&!rejected.has(r.from_entity_id)&&!rejected.has(r.to_entity_id))items.push({key:JSON.stringify(['RELATIONSHIP',r.from_entity_type,r.from_entity_id||r.from_label,r.to_entity_type,r.to_entity_id||r.to_label,r.relationship_type]),kind:'RELATIONSHIP',label:`${r.from_label} → ${r.to_label}`,value:[r.relationship_type,r.valid_from||'',r.valid_to||''].join(' · '),evidenceIds:refs(r,'relationship_evidence')});
 for(const r of d.events||[])if(valid(r,'event_evidence')&&!rejected.has(r.company_id))items.push({key:JSON.stringify(['EVENT',r.company_id||r.lead_id,r.source_dedupe_key||r.id]),kind:'EVENT',label:String(r.title),value:[r.event_date||'Sem data',r.description||r.event_type].join(' · '),evidenceIds:refs(r,'event_evidence')});
 // Multivalued facts are grouped, so row order and duplicate source IDs never manufacture changes.
 const grouped=new Map<string,HistoryItem>();
 for(const item of items){const prev=grouped.get(item.key);if(!prev)grouped.set(item.key,item);else grouped.set(item.key,{...prev,value:[...new Set([...prev.value.split('\n'),item.value])].sort().join('\n'),evidenceIds:[...new Set([...prev.evidenceIds,...item.evidenceIds])].sort()});}
 const result=[...grouped.values()].sort((a,b)=>a.key.localeCompare(b.key));
 const used=new Set(result.flatMap(i=>i.evidenceIds));
 const run=[...(d.research_runs||[])].sort((a:Row,b:Row)=>String(b.created_at).localeCompare(String(a.created_at)))[0];
 return {version:1,identity:String(d.lead?.identity_status||'PENDING'),items:result,gaps:(run?.research_steps||[]).filter((s:Row)=>s.source_key&&!['COMPLETED'].includes(s.status)).map((s:Row)=>({source:String(s.source_key),status:String(s.status)})).sort((a:Row,b:Row)=>a.source.localeCompare(b.source)),sources:(d.evidence||[]).filter((e:Row)=>used.has(e.id)).map((e:Row)=>({id:e.id,title:String(e.title),url:/^https?:\/\//.test(e.source_url||'')?e.source_url:null,date:e.source_date||e.retrieved_at||null})).sort((a:Row,b:Row)=>a.id.localeCompare(b.id))};
}
export function semanticSnapshot(s:IntelligenceSnapshot){return JSON.stringify({version:s.version,identity:s.identity,items:s.items.map(({key,kind,value})=>({key,kind,value})),gaps:s.gaps});}
export function compareIntelligence(before:IntelligenceSnapshot,after:IntelligenceSnapshot){
 const old=new Map(before.items.map(i=>[i.key,i])),now=new Map(after.items.map(i=>[i.key,i]));
 const changes:{type:'ADDED'|'CHANGED'|'NO_LONGER_SUPPORTED';before:HistoryItem|null;after:HistoryItem|null}[]=[];
 for(const [key,item] of now){const prev=old.get(key);if(!prev)changes.push({type:'ADDED',before:null,after:item});else if(prev.value!==item.value)changes.push({type:'CHANGED',before:prev,after:item});}
 for(const [key,item] of old)if(!now.has(key))changes.push({type:'NO_LONGER_SUPPORTED',before:item,after:null});
 return {changes,identityChanged:before.identity!==after.identity,sourceCoverageChanged:JSON.stringify(before.gaps)!==JSON.stringify(after.gaps)};
}
