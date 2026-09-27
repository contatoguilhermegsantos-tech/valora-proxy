'use client'
import { useEffect,useState } from 'react'
import { Shell } from '@/components/Shell'
import { StatusBadge } from '@/components/StatusBadge'
import { supabaseBrowser } from '@/lib/supabase'
export default function Sources(){
 const [rows,setRows]=useState<any[]>([]);const [sync,setSync]=useState<any[]>([]);const [backfill,setBackfill]=useState<any[]>([])
 useEffect(()=>{(async()=>{const sb=supabaseBrowser();const [{data:r},{data:s},{data:b}]=await Promise.all([sb.from('source_registry').select('*').order('name'),sb.from('source_sync_state').select('*'),sb.from('source_backfill_queue').select('source_key,target_date,status,attempts').order('target_date')]);setRows(r??[]);setSync(s??[]);setBackfill(b??[])})()},[])
 const syncMap=new Map<string,any>(sync.map((s:any)=>[s.source_key,s]));const pending=backfill.filter(x=>x.source_key==='pncp'&&x.status!=='DONE').length;const done=backfill.filter(x=>x.source_key==='pncp'&&x.status==='DONE').length
 return <Shell><div className="top"><div><div className="h1">Fontes</div><div className="sub">A fonte faz parte do produto. O usuário vê o que está conectado, limitado, manual ou pendente.</div></div></div>{backfill.length>0&&<div className="banner section"><strong>PNCP — construção de cobertura histórica:</strong> {done}/{backfill.length} dia(s) concluído(s), {pending} restante(s). O worker processa lotes pequenos para evitar timeout e preservar rastreabilidade.</div>}<div className="card table-wrap section"><table className="table"><thead><tr><th>Fonte</th><th>Categoria</th><th>Tipo</th><th>Status</th><th>Última cobertura</th><th>Limitações / ação</th></tr></thead><tbody>{rows.map(r=>{const s=syncMap.get(r.key);return <tr key={r.id}><td><strong>{r.name}</strong><div className="micro">{r.domain||r.key}</div></td><td>{r.category}</td><td>{r.source_tier}</td><td><StatusBadge value={r.connection_status}/></td><td>{s?.last_successful_date||s?.last_status||'—'}</td><td className="muted">{r.limitations||r.coverage_notes||'—'}{r.action_url&&<div><a className="source-link" href={r.action_url} target="_blank" rel="noreferrer">Abrir fonte oficial ↗</a></div>}</td></tr>})}</tbody></table></div></Shell>
}
