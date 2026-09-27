'use client'
import Link from 'next/link'
import { useEffect,useState } from 'react'
import { usePathname,useRouter } from 'next/navigation'
import { supabaseBrowser } from '@/lib/supabase'
import { AuthGate } from './AuthGate'

type Workspace={id:string;name:string;plan_key:string;role:string}
export function Shell({children}:{children:React.ReactNode}){
  const path=usePathname(); const router=useRouter(); const [workspaces,setWorkspaces]=useState<Workspace[]>([]);const [active,setActive]=useState('');
  const items=[['/dashboard','Visão geral'],['/leads','Leads'],['/research','Pesquisas'],['/sources','Fontes'],['/team','Equipe']]
  useEffect(()=>{(async()=>{const sb=supabaseBrowser();const {data:j,error}=await sb.functions.invoke('workspaces',{body:{action:'list'}});if(error)return;setWorkspaces(j?.organizations||[]);setActive(j?.active_organization_id||'')})()},[])
  async function logout(){await supabaseBrowser().auth.signOut();router.replace('/login')}
  async function switchWorkspace(id:string){if(!id||id===active)return;const {error}=await supabaseBrowser().functions.invoke('workspaces',{body:{action:'switch',organization_id:id}});if(error){window.alert(error.message);return}setActive(id);window.location.href='/dashboard'}
  return <AuthGate><div className="shell"><aside className="sidebar">
    <div className="brand">MAX<small>INTELLIGENCE SaaS</small></div>
    <div className="brand-tag">Contexto comercial com prova.</div>
    {workspaces.length>0&&<div style={{marginTop:20}}><div className="micro" style={{marginBottom:6}}>WORKSPACE</div><select className="workspace-select" value={active} onChange={e=>switchWorkspace(e.target.value)}>{workspaces.map(w=><option key={w.id} value={w.id}>{w.name} · {w.role}</option>)}</select></div>}
    <nav className="nav">{items.map(([href,label])=><Link key={href} href={href} className={path.startsWith(href)?'active':''}>{label}</Link>)}</nav>
    <div className="sidebar-foot"><div className="micro">FATO → EVIDÊNCIA → CONTEXTO</div><div className="micro">Modo de teste · acesso automático</div>{process.env.NEXT_PUBLIC_MAX_TEST_MODE==='false'&&<button className="link-btn" onClick={logout}>Sair</button>}</div>
  </aside><main className="main">{children}</main></div></AuthGate>
}
