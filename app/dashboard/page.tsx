'use client'
import { useEffect,useState } from 'react'
import Link from 'next/link'
import { Shell } from '@/components/Shell'
import { AuthGate } from '@/components/AuthGate'
import { StatusBadge } from '@/components/StatusBadge'
import { supabaseBrowser } from '@/lib/supabase'
import {readWorkspaceOverview,type OverviewSnapshot} from '@/lib/workspace-views'

export default function Dashboard(){return <AuthGate><DashboardContent/></AuthGate>}
function DashboardContent(){
 const [snapshot,setSnapshot]=useState<OverviewSnapshot|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(true),[revision,setRevision]=useState(0)
 useEffect(()=>{let cancelled=false;setLoading(true);setError('');void readWorkspaceOverview(supabaseBrowser()).then(data=>{if(!cancelled)setSnapshot(data)}).catch(()=>{if(!cancelled)setError('Não foi possível atualizar a visão geral. Tente novamente.')}).finally(()=>{if(!cancelled)setLoading(false)});return()=>{cancelled=true}},[revision])
 const stats=snapshot?.stats,sources=snapshot?.sources||[],runs=snapshot?.runs||[]
 return <Shell><div className="top"><div><h1 className="h1">Visão geral</h1><div className="sub">O MAX só confirma o que consegue provar — e mostra o que ainda falta pesquisar.</div></div><div className="actions"><button className="btn secondary" disabled={loading} onClick={()=>setRevision(v=>v+1)}>{loading?'Atualizando…':'Atualizar'}</button><Link className="btn lead-link" style={{color:'#fff'}} href="/leads#nova-pesquisa">Nova pesquisa</Link></div></div>
 {error&&<div className="banner bad section" role="alert">{error}{snapshot&&' Os dados abaixo são da última atualização concluída.'}</div>}
 <div className="grid" aria-busy={loading}><Metric label="Leads" value={stats?.leads}/><Metric label="Evidências" value={stats?.evidence}/><Metric label="Fatos verificados" value={stats?.verified}/><Metric label="Divergências abertas" value={stats?.divs}/></div>
 <div className="two section"><div className="card"><h3>Pesquisas recentes</h3>{runs.length?<div className="table-wrap"><table className="table"><thead><tr><th>Lead</th><th>Estratégia</th><th>Status</th><th>Quando</th></tr></thead><tbody>{runs.map(r=><tr key={r.id}><td><Link className="lead-link" href={`/leads/${r.lead_id}`}>{r.leads?.name||'Lead'}</Link></td><td>{r.strategy}</td><td><StatusBadge value={r.status}/></td><td>{new Date(r.created_at).toLocaleString('pt-BR')}</td></tr>)}</tbody></table></div>:<div className="empty">{snapshot?'Nenhuma pesquisa iniciada.':loading?'Carregando pesquisas…':'Pesquisas não carregadas.'}</div>}</div>
 <div className="card"><h3>Fontes cadastradas</h3><p className="muted">A configuração não confirma disponibilidade ou cobertura. <Link className="source-link" href="/sources">Ver consultas e limitações das fontes</Link></p><div className="stack">{sources.map(s=><div key={s.key} style={{display:'flex',justifyContent:'space-between',gap:8}}><span>{s.name}</span><StatusBadge value={s.connection_status}/></div>)}</div></div></div>
 <div className="grid3 section"><div className="card"><strong>Fatos com prova</strong><p className="muted">Um fato só é apresentado como verificado quando possui evidência verificada vinculada.</p></div><div className="card"><strong>Divergências visíveis</strong><p className="muted">Valores factuais incompatíveis no mesmo período abrem divergência; o MAX não escolhe silenciosamente.</p></div><div className="card"><strong>Pesquisa acompanhada</strong><p className="muted">Empresário, Agro, Médico e Genérico usam trilhas diferentes e registram cada etapa executada ou bloqueada.</p></div></div>
 </Shell>
}
function Metric({label,value}:{label:string;value?:number}){return <div className="card"><div className="muted">{label}</div><div className="metric">{value??'—'}</div></div>}
