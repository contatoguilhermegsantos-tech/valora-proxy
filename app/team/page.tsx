'use client'
import { useEffect,useState } from 'react'
import { Shell } from '@/components/Shell'
import { StatusBadge } from '@/components/StatusBadge'
import { supabaseBrowser } from '@/lib/supabase'

type TeamData={organization:any;my_role:string;members:any[]}
export default function Team(){
  const [data,setData]=useState<TeamData|null>(null);const [email,setEmail]=useState('');const [role,setRole]=useState('MEMBER');const [msg,setMsg]=useState('');const [busy,setBusy]=useState(false)
  async function load(){
    const sb=supabaseBrowser();const {data:json,error}=await sb.functions.invoke('team-admin',{body:{action:'list'}});if(error)setMsg(error.message);else setData(json)
  }
  useEffect(()=>{load()},[])
  async function invite(e:React.FormEvent){e.preventDefault();setBusy(true);setMsg('');const redirect=typeof window!=='undefined'?`${window.location.origin}/login`:undefined;const {data:r,error}=await supabaseBrowser().functions.invoke('team-admin',{body:{action:'invite',email,role,redirect_to:redirect}});if(error)setMsg(error.message);else{setMsg(`Convite/acesso preparado para ${r.email}.`);setEmail('');await load()}setBusy(false)}
  async function updateRole(userId:string,newRole:string){setBusy(true);const {error}=await supabaseBrowser().functions.invoke('team-admin',{body:{action:'update_role',user_id:userId,role:newRole}});if(error)setMsg(error.message);await load();setBusy(false)}
  async function remove(userId:string){if(!window.confirm('Remover este membro do workspace?'))return;setBusy(true);const {error}=await supabaseBrowser().functions.invoke('team-admin',{body:{action:'remove',user_id:userId}});if(error)setMsg(error.message);await load();setBusy(false)}
  const canAdmin=['OWNER','ADMIN'].includes(data?.my_role||'')
  return <Shell><div className="top"><div><div className="h1">Equipe</div><div className="sub">Workspace isolado por organização, com acesso controlado por RLS.</div></div></div>{msg&&<div className="banner section">{msg}</div>}<div className="two section"><div className="card"><h3>{data?.organization?.name||'Workspace'}</h3><div className="table-wrap"><table className="table"><thead><tr><th>Membro</th><th>Papel</th><th>Status</th><th></th></tr></thead><tbody>{(data?.members??[]).map(m=><tr key={m.user_id}><td><strong>{m.profile?.full_name||m.profile?.email||m.user_id.slice(0,8)}</strong><div className="micro">{m.profile?.email||m.user_id}</div></td><td>{m.role==='OWNER'?<span className="badge neutral">OWNER</span>:canAdmin?<select className="select" value={m.role} disabled={busy} onChange={e=>updateRole(m.user_id,e.target.value)}><option>ADMIN</option><option>ANALYST</option><option>MEMBER</option><option>VIEWER</option></select>:m.role}</td><td><StatusBadge value={m.status}/></td><td>{canAdmin&&m.role!=='OWNER'&&<button className="link-btn" style={{color:'#b42318'}} onClick={()=>remove(m.user_id)}>Remover</button>}</td></tr>)}</tbody></table></div>{!data?.members?.length&&<div className="empty">Carregando membros…</div>}</div>
  <div className="card"><h3>Adicionar usuário</h3>{canAdmin?<form className="form" onSubmit={invite}><label className="label">E-mail<input className="input" type="email" required value={email} onChange={e=>setEmail(e.target.value)} placeholder="nome@empresa.com"/></label><label className="label">Papel<select className="select" value={role} onChange={e=>setRole(e.target.value)}><option value="ADMIN">ADMIN</option><option value="ANALYST">ANALYST</option><option value="MEMBER">MEMBER</option><option value="VIEWER">VIEWER</option></select></label><button className="btn" disabled={busy}>{busy?'Processando…':'Convidar / conceder acesso'}</button><p className="muted">Cada usuário continua tendo identidade própria; o acesso aos dados é pelo workspace.</p></form>:<div className="empty">Seu papel atual não permite administrar a equipe.</div>}</div></div></Shell>
}
