'use client'
import { useCallback,useEffect,useState } from 'react'
import Link from 'next/link'
import { Shell } from '@/components/Shell'
import { StatusBadge } from '@/components/StatusBadge'
import { supabaseBrowser } from '@/lib/supabase'

export default function Research(){
 const [runs,setRuns]=useState<any[]>([]);const [jobs,setJobs]=useState<any[]>([])
 const load=useCallback(async()=>{
  const sb=supabaseBrowser()
  const [runRes,jobRes]=await Promise.all([
   sb.from('research_runs').select('*,leads(name),research_steps(*)').order('created_at',{ascending:false}).limit(100),
   sb.functions.invoke('research-queue',{body:{action:'list',limit:100}})
  ])
  setRuns(runRes.data??[])
  if(!jobRes.error)setJobs(jobRes.data?.jobs||[])
 },[])
 useEffect(()=>{void load()},[load])
 useEffect(()=>{
  if(!jobs.some((j:any)=>['PENDING','RUNNING','RETRY'].includes(j.status)))return
  const t=setInterval(()=>{void load()},3000)
  return()=>clearInterval(t)
 },[jobs,load])
 return <Shell>
  <div className="top"><div><div className="h1">Pesquisas</div><div className="sub">Trilha auditável de pesquisas concluídas e investigações em processamento.</div></div></div>
  {jobs.length>0&&<div className="card section"><h3>Fila de investigação</h3>{jobs.slice(0,20).map((j:any)=><div className="research-step" key={j.id}><div className="step-num">↻</div><div><Link className="lead-link" href={`/leads/${j.lead_id}`}>Lead</Link><div><strong>{j.strategy}</strong> · {j.progress?.message||'Aguardando processamento.'}</div><div className="micro">{new Date(j.created_at).toLocaleString('pt-BR')}{j.attempts? ` · tentativa ${j.attempts}/${j.max_attempts}`:''}</div>{j.last_error&&<div className="micro" style={{color:'#b42318'}}>{j.last_error}</div>}</div><StatusBadge value={j.status}/></div>)}</div>}
  <div className="stack section">{runs.map(r=><div className="card" key={r.id}><div style={{display:'flex',justifyContent:'space-between',gap:12}}><div><Link className="lead-link" href={`/leads/${r.lead_id}`}>{r.leads?.name||'Lead'}</Link><div className="micro">{r.strategy} · {new Date(r.created_at).toLocaleString('pt-BR')}</div></div><StatusBadge value={r.status}/></div><div className="section">{(r.research_steps||[]).sort((a:any,b:any)=>a.step_order-b.step_order).map((s:any)=><div className="research-step" key={s.id}><div className="step-num">{s.step_order}</div><div><strong>{s.title}</strong><div className="muted">{s.result_summary||s.error_summary||'Aguardando execução'}</div>{s.action_url&&<a className="source-link" target="_blank" rel="noreferrer" href={s.action_url}>Abrir fonte ↗</a>}</div><StatusBadge value={s.status}/></div>)}</div></div>)}{!runs.length&&<div className="empty">As pesquisas iniciadas nos dossiês aparecerão aqui.</div>}</div>
 </Shell>
}
