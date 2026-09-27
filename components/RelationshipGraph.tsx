'use client'
import { useMemo,useState } from 'react'
import { supabaseBrowser } from '@/lib/supabase'

type Rel={id:string;from_entity_type:string;from_entity_id:string|null;from_label:string;to_entity_type:string;to_entity_id:string|null;to_label:string;relationship_type:string;classification:string;confidence:string;status:string}
export function RelationshipGraph({leadId,leadName,relationships,onPromoted}:{leadId:string;leadName:string;relationships:Rel[];onPromoted?:(id:string)=>void}){
  const [busy,setBusy]=useState<string|null>(null)
  const nodes=useMemo(()=>{
    const map=new Map<string,{key:string;type:string;id:string|null;label:string;x:number;y:number}>()
    map.set('lead',{key:'lead',type:'LEAD',id:leadId,label:leadName,x:20,y:40})
    const byType:{[k:string]:{key:string;type:string;id:string|null;label:string}[]}={COMPANY:[],PERSON:[],PUBLIC_BODY:[],GROUP:[]}
    for(const r of relationships){
      for(const n of [{type:r.from_entity_type,id:r.from_entity_id,label:r.from_label},{type:r.to_entity_type,id:r.to_entity_id,label:r.to_label}]){
        if(n.type==='LEAD') continue
        const key=`${n.type}:${n.id||n.label}`
        if(!map.has(key) && byType[n.type]) byType[n.type].push({key,type:n.type,id:n.id,label:n.label})
      }
    }
    const cols:{[k:string]:number}={COMPANY:300,PERSON:590,PUBLIC_BODY:880,GROUP:590}
    for(const type of Object.keys(byType)) byType[type].forEach((n,i)=>map.set(n.key,{...n,x:cols[type],y:30+i*105}))
    return [...map.values()]
  },[leadId,leadName,relationships])
  const nodeMap=new Map(nodes.map(n=>[`${n.type}:${n.id||n.label}`,n])); nodeMap.set('LEAD:'+leadId,nodes[0])
  const h=Math.max(300,...nodes.map(n=>n.y+95))
  async function expand(type:string,id:string|null){if(!id||!['PERSON','COMPANY'].includes(type))return;setBusy(id);try{
    const {data,error}=await supabaseBrowser().functions.invoke('promote-node',{body:{origin_lead_id:leadId,entity_type:type,entity_id:id}})
    if(error) throw error
    const newId=data?.lead?.id;if(newId){onPromoted?.(newId);window.location.href=`/leads/${newId}`}
  }finally{setBusy(null)}}
  return <div className="graph-wrap" style={{height:h}}>
    <svg className="graph-lines" width="100%" height={h}>{relationships.map(r=>{
      const a=r.from_entity_type==='LEAD'?nodes[0]:nodeMap.get(`${r.from_entity_type}:${r.from_entity_id||r.from_label}`)
      const b=r.to_entity_type==='LEAD'?nodes[0]:nodeMap.get(`${r.to_entity_type}:${r.to_entity_id||r.to_label}`)
      if(!a||!b)return null
      return <g key={r.id}><line x1={a.x+180} y1={a.y+35} x2={b.x} y2={b.y+35}/><text x={(a.x+b.x+180)/2} y={(a.y+b.y+70)/2-6}>{r.relationship_type}</text></g>
    })}</svg>
    {nodes.map(n=><div key={n.key} className={`graph-node graph-${n.type.toLowerCase()}`} style={{left:n.x,top:n.y}}>
      <div className="graph-type">{n.type}</div><strong>{n.label}</strong>
      {['PERSON','COMPANY'].includes(n.type)&&n.id&&<button disabled={busy===n.id} onClick={()=>expand(n.type,n.id)}>{busy===n.id?'Abrindo…':'Expandir este núcleo'}</button>}
    </div>)}
  </div>
}
