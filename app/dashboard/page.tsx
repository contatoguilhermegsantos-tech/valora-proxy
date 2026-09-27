'use client'
import { useEffect,useState } from 'react'
import Link from 'next/link'
import { Shell } from '@/components/Shell'
import { StatusBadge } from '@/components/StatusBadge'
import { supabaseBrowser } from '@/lib/supabase'

export default function Dashboard(){
 const [stats,setStats]=useState({leads:0,evidence:0,claims:0,runs:0,verified:0,divs:0}); const [sources,setSources]=useState<any[]>([]); const [runs,setRuns]=useState<any[]>([])
 useEffect(()=>{(async()=>{const sb=supabaseBrowser();const tables=['leads','evidence','claims','research_runs'] as const;const vals=await Promise.all(tables.map(t=>sb.from(t).select('*',{count:'exact',head:true})));const [{count:verified},{count:divs},{data:s},{data:r}]=await Promise.all([sb.from('claims').select('*',{count:'exact',head:true}).eq('status','VERIFIED'),sb.from('divergences').select('*',{count:'exact',head:true}).eq('status','OPEN'),sb.from('source_registry').select('key,name,connection_status,source_tier').order('name'),sb.from('research_runs').select('id,strategy,status,created_at,leads(name)').order('created_at',{ascending:false}).limit(6)]);setStats({leads:vals[0].count??0,evidence:vals[1].count??0,claims:vals[2].count??0,runs:vals[3].count??0,verified:verified??0,divs:divs??0});setSources(s??[]);setRuns(r??[])})()},[])
 return <Shell><div className="top"><div><div className="h1">Visão geral</div><div className="sub">O MAX só confirma o que consegue provar — e mostra o que ainda falta pesquisar.</div></div><Link className="btn lead-link" style={{color:'#fff'}} href="/leads">Novo lead</Link></div>
 <div className="grid"><Metric label="Leads" value={stats.leads}/><Metric label="Evidências" value={stats.evidence}/><Metric label="Fatos verificados" value={stats.verified}/><Metric label="Divergências abertas" value={stats.divs}/></div>
 <div className="two section"><div className="card"><h3>Pesquisas recentes</h3>{runs.length?<div className="table-wrap"><table className="table"><thead><tr><th>Lead</th><th>Estratégia</th><th>Status</th><th>Quando</th></tr></thead><tbody>{runs.map(r=><tr key={r.id}><td>{r.leads?.name||'—'}</td><td>{r.strategy}</td><td><StatusBadge value={r.status}/></td><td>{new Date(r.created_at).toLocaleString('pt-BR')}</td></tr>)}</tbody></table></div>:<div className="empty">Nenhuma pesquisa iniciada.</div>}</div>
 <div className="card"><h3>Saúde das fontes</h3><div className="stack">{sources.map(s=><div key={s.key} style={{display:'flex',justifyContent:'space-between',gap:8}}><span>{s.name}</span><StatusBadge value={s.connection_status}/></div>)}</div></div></div>
 <div className="grid3 section"><div className="card"><strong>Evidence Engine</strong><p className="muted">Nenhum FACT/VERIFIED passa sem evidência verificada vinculada.</p></div><div className="card"><strong>Contradiction Engine</strong><p className="muted">Valores factuais incompatíveis no mesmo período abrem divergência; o MAX não escolhe silenciosamente.</p></div><div className="card"><strong>Research Orchestrator</strong><p className="muted">Empresário, Agro, Médico e Genérico usam trilhas diferentes e registram cada etapa executada ou bloqueada.</p></div></div>
 </Shell>
}
function Metric({label,value}:{label:string;value:number}){return <div className="card"><div className="muted">{label}</div><div className="metric">{value}</div></div>}
