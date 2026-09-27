'use client'
import { useEffect,useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabaseBrowser } from '@/lib/supabase'

const TEST_MODE = process.env.NEXT_PUBLIC_MAX_TEST_MODE !== 'false'

export function AuthGate({children}:{children:React.ReactNode}){
  const [ready,setReady]=useState(false)
  const [error,setError]=useState('')
  const router=useRouter()
  useEffect(()=>{let live=true;(async()=>{
    const sb=supabaseBrowser()
    let {data:{session}}=await sb.auth.getSession()
    if(!session && TEST_MODE){
      const {data,error}=await sb.auth.signInAnonymously({options:{data:{purpose:'max-v1-preview'}}})
      if(error){if(live)setError(error.message);return}
      session=data.session
    }
    if(!session){router.replace('/login');return}
    if(live)setReady(true)
  })();return()=>{live=false}},[router])
  if(error) return <div className="page-loading"><div><strong>Não foi possível iniciar a sessão de teste.</strong><div className="muted" style={{marginTop:8}}>{error}</div></div></div>
  if(!ready) return <div className="page-loading">Carregando ambiente de testes…</div>
  return <>{children}</>
}
