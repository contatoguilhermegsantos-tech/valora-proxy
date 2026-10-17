'use client'
import { useCallback,useEffect,useRef,useState } from 'react'
import Link from 'next/link'
import { Shell } from '@/components/Shell'
import { AuthGate } from '@/components/AuthGate'
import { StatusBadge } from '@/components/StatusBadge'
import { supabaseBrowser } from '@/lib/supabase'
import {readWorkspaceResearch} from '@/lib/workspace-views'
import {researchHref} from '@/lib/research-progress'

export default function Research(){return <AuthGate><ResearchContent/></AuthGate>}
function ResearchContent(){
 const [runs,setRuns]=useState<any[]>([]);const [jobs,setJobs]=useState<any[]>([])
 const [error,setError]=useState(''),[loading,setLoading]=useState(true),[loaded,setLoaded]=useState(false)
 const live=useRef(true),pending=useRef<ReturnType<typeof readWorkspaceResearch>|null>(null)
 const load=useCallback(async()=>{
  if(!pending.current)pending.current=readWorkspaceResearch(supabaseBrowser())
  const request=pending.current;if(live.current)setLoading(true)
  try{const result=await request;if(live.current){setRuns(result.runs);setJobs(result.jobs);setError('');setLoaded(true)}}
  catch{if(live.current)setError('Não foi possível atualizar as pesquisas. Os resultados anteriores, quando disponíveis, foram preservados.')}
  finally{if(pending.current===request)pending.current=null;if(live.current)setLoading(false)}
 },[])
 useEffect(()=>{live.current=true;void load();return()=>{live.current=false}},[load])
 useEffect(()=>{
  if(!jobs.some((j:any)=>['PENDING','RUNNING','RETRY'].includes(j.status)))return
  const t=setInterval(()=>{void load()},3000)
  return()=>clearInterval(t)
 },[jobs,load])
 return <Shell>
  <div className="top"><div><h1 className="h1">Pesquisas</h1><div className="sub">Trilha auditável de pesquisas concluídas e investigações em processamento. Até 100 execuções recentes.</div></div><button className="btn secondary" disabled={loading} onClick={()=>{void load()}}>{loading?'Atualizando…':'Atualizar pesquisas'}</button></div>
  {error&&<div className="banner bad section" role="alert">{error}</div>}
  {!loaded&&<div className="empty">{loading?'Carregando pesquisas…':'As pesquisas ainda não puderam ser carregadas.'}</div>}
  {jobs.length>0&&<div className="card section"><h3>Fila de investigação</h3>{jobs.slice(0,20).map((j:any)=><div className="research-step" key={j.id}><div className="step-num">↻</div><div><Link className="lead-link" href={j.job_type==='COMPANY_CONTEXT'?`/leads/${j.lead_id}`:researchHref(j.lead_id,j.id)}>Lead</Link><div><strong>{j.strategy}</strong> · {j.progress?.message||'Aguardando processamento.'}</div><div className="micro">{new Date(j.created_at).toLocaleString('pt-BR')}{j.attempts? ` · tentativa ${j.attempts}/${j.max_attempts}`:''}</div>{j.last_error&&<div className="micro" style={{color:'#b42318'}}>{j.last_error}</div>}</div><StatusBadge value={j.status}/></div>)}</div>}
  <div className="stack section">{runs.map(r=><div className="card" key={r.id}><div style={{display:'flex',justifyContent:'space-between',gap:12}}><div><Link className="lead-link" href={`/leads/${r.lead_id}`}>{r.leads?.name||'Lead'}</Link><div className="micro">{r.strategy} · {new Date(r.created_at).toLocaleString('pt-BR')}</div></div><StatusBadge value={r.status}/></div><div className="section">{(r.research_steps||[]).sort((a:any,b:any)=>a.step_order-b.step_order).map((s:any)=><div className="research-step" key={s.id}><div className="step-num">{s.step_order}</div><div><strong>{s.title}</strong><div className="muted">{s.result_summary||s.error_summary||'Aguardando execução'}</div>{s.action_url&&<a className="source-link" target="_blank" rel="noreferrer" href={s.action_url}>Abrir fonte ↗</a>}</div><StatusBadge value={s.status}/></div>)}</div></div>)}{loaded&&!runs.length&&<div className="empty">As pesquisas iniciadas nos dossiês aparecerão aqui.</div>}</div>
 </Shell>
}
