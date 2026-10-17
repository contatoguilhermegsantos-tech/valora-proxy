'use client'
import { useMemo,useState } from 'react'
import { supabaseBrowser } from '@/lib/supabase'

type Rel={id:string;from_entity_type:string;from_entity_id:string|null;from_label:string;to_entity_type:string;to_entity_id:string|null;to_label:string;relationship_type:string;classification:string;confidence:string;status:string}
export function RelationshipGraph({leadId,leadName,relationships,expandableRelationshipIds=[],onPromoted,readOnly=false}:{leadId:string;leadName:string;relationships:Rel[];expandableRelationshipIds?:string[];readOnly?:boolean;onPromoted?:(id:string)=>void}){
  const [error,setError]=useState('')
  const [openedLead,setOpenedLead]=useState<string|null>(null)
  const [busy,setBusy]=useState<string|null>(null)
  const nodes=useMemo(()=>{
    const map=new Map<string,{key:string;type:string;id:string|null;label:string;x:number;y:number}>()
    map.set('lead',{key:'lead',type:'LEAD',id:leadId,label:leadName,x:20,y:40})
    const seen=new Set<string>()
    const byType:{[k:string]:{key:string;type:string;id:string|null;label:string}[]}={COMPANY:[],PERSON:[],PUBLIC_BODY:[],GROUP:[]}
    for(const r of relationships){
      for(const n of [{type:r.from_entity_type,id:r.from_entity_id,label:r.from_label},{type:r.to_entity_type,id:r.to_entity_id,label:r.to_label}]){
        if(n.type==='LEAD') continue
        const key=`${n.type}:${n.id||n.label}`
        if(!seen.has(key) && byType[n.type]) {seen.add(key);byType[n.type].push({key,type:n.type,id:n.id,label:n.label})}
      }
    }
    const cols:{[k:string]:number}={COMPANY:300,PERSON:590,PUBLIC_BODY:880,GROUP:590}
    for(const type of Object.keys(byType)) byType[type].forEach((n,i)=>map.set(n.key,{...n,x:cols[type],y:30+i*105}))
    return [...map.values()]
  },[leadId,leadName,relationships])
  const nodeMap=new Map(nodes.map(n=>[`${n.type}:${n.id||n.label}`,n])); nodeMap.set('LEAD:'+leadId,nodes[0])
  const h=Math.max(300,...nodes.map(n=>n.y+95))
  const expandable=new Set(expandableRelationshipIds)
  const canExpand=(type:string,id:string|null)=>Boolean(id)&&relationships.some(r=>expandable.has(r.id)&&['PENDING','SUPPORTED','VERIFIED'].includes(r.status)&&((r.from_entity_type===type&&r.from_entity_id===id)||(r.to_entity_type===type&&r.to_entity_id===id)))
  async function expand(type:string,id:string|null){if(readOnly||busy||!id||!['PERSON','COMPANY'].includes(type)||!canExpand(type,id))return;setError('');setBusy(id);try{
    const {data,error}=await supabaseBrowser().functions.invoke('promote-node',{body:{origin_lead_id:leadId,entity_type:type,entity_id:id}})
    if(error) throw error
    const newId=data?.lead?.id;if(newId){if(data.research_error){setOpenedLead(newId);setError(data.research_error);return}onPromoted?.(newId);window.location.href=`/leads/${newId}`}
  }catch(e){setError(e instanceof Error?e.message:'Não foi possível abrir este núcleo.')}finally{setBusy(null)}}
  return <>{error&&<div role="alert" className="banner bad">{error}{openedLead&&<div><a className="lead-link" href={`/leads/${openedLead}`}>Abrir dossiê e tentar a pesquisa novamente</a></div>}</div>}<div className="graph-wrap" style={{height:h}}>
    <svg className="graph-lines" width="100%" height={h}>{relationships.map(r=>{
      const a=r.from_entity_type==='LEAD'?nodes[0]:nodeMap.get(`${r.from_entity_type}:${r.from_entity_id||r.from_label}`)
      const b=r.to_entity_type==='LEAD'?nodes[0]:nodeMap.get(`${r.to_entity_type}:${r.to_entity_id||r.to_label}`)
      if(!a||!b)return null
      const conflict=r.status==='CONTRADICTED',supported=expandable.has(r.id),verified=r.status==='VERIFIED'&&supported
      const label=conflict?'Em conflito; revisar':!supported?'Sem suporte vigente':verified?'Documentada':r.status==='SUPPORTED'?'Com suporte; validar':'A validar'
      return <g key={r.id}><line style={{stroke:conflict?'#b42318':verified?'#475467':'#b54708',strokeDasharray:verified?undefined:'6 5'}} x1={a.x+180} y1={a.y+35} x2={b.x} y2={b.y+35}/><text fill={conflict?'#b42318':undefined} x={(a.x+b.x+180)/2} y={(a.y+b.y+70)/2-6}>{r.relationship_type==='QSA_PARTICIPANT'?'Participante QSA':r.relationship_type} · {label}</text></g>
    })}</svg>
    {nodes.map(n=><div key={n.key} className={`graph-node graph-${n.type.toLowerCase()}`} style={{left:n.x,top:n.y}}>
      <div className="graph-type">{n.type}</div><strong>{n.label}</strong>
      {['PERSON','COMPANY'].includes(n.type)&&n.id&&(canExpand(n.type,n.id)?<button disabled={readOnly||Boolean(busy)} onClick={()=>expand(n.type,n.id)}>{busy===n.id?'Abrindo…':'Expandir este núcleo'}</button>:<p className="micro caution">Vínculo em revisão; expansão bloqueada.</p>)}
    </div>)}
  </div></>
}
