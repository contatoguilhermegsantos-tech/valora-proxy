'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabaseBrowser } from '@/lib/supabase'

export default function Login(){
  const [mode,setMode]=useState<'login'|'signup'>('login'); const [name,setName]=useState(''); const [email,setEmail]=useState(''); const [password,setPassword]=useState(''); const [msg,setMsg]=useState(''); const [busy,setBusy]=useState(false); const router=useRouter()
  async function submit(e:React.FormEvent){e.preventDefault();setBusy(true);setMsg('');const sb=supabaseBrowser();try{
    if(mode==='login'){
      const {error}=await sb.auth.signInWithPassword({email,password});if(error)throw error;router.push('/dashboard')
    }else{
      const {data,error}=await sb.auth.signUp({email,password,options:{data:{full_name:name}}});if(error)throw error
      if(data.session) router.push('/dashboard'); else setMsg('Conta criada. Confira seu e-mail caso a confirmação esteja habilitada.')
    }
  }catch(err:any){setMsg(err.message||'Não foi possível continuar.')}finally{setBusy(false)}}
  return <div className="login-wrap"><div className="login-card"><div className="brand" style={{color:'#111827'}}>MAX<small style={{color:'#64748b'}}>INTELLIGENCE SaaS</small></div><h1 style={{marginTop:28}}>{mode==='login'?'Entrar':'Criar conta'}</h1><p className="muted">Qualificação profunda de leads com evidência rastreável.</p>
    <div className="tabs"><button className={mode==='login'?'active':''} onClick={()=>setMode('login')}>Entrar</button><button className={mode==='signup'?'active':''} onClick={()=>setMode('signup')}>Criar conta</button></div>
    <form className="form" onSubmit={submit}>{mode==='signup'&&<label className="label">Nome<input className="input" value={name} onChange={e=>setName(e.target.value)} required/></label>}<label className="label">E-mail<input className="input" type="email" value={email} onChange={e=>setEmail(e.target.value)} required/></label><label className="label">Senha<input className="input" type="password" minLength={6} value={password} onChange={e=>setPassword(e.target.value)} required/></label><button className="btn" disabled={busy}>{busy?'Aguarde…':mode==='login'?'Entrar':'Criar conta'}</button>{msg&&<div className="banner">{msg}</div>}</form>
    <div className="caution" style={{marginTop:18}}>O MAX separa fato, indício e hipótese. Dados sem fonte suficiente permanecem pendentes.</div>
  </div></div>
}
