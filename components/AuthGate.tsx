'use client'
import { useEffect,useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { supabaseBrowser } from '@/lib/supabase'

const TEST_MODE = process.env.NEXT_PUBLIC_MAX_TEST_MODE !== 'false'

export function AuthGate({children}:{children:React.ReactNode}){
  const [ready,setReady]=useState(false)
  const [error,setError]=useState(false)
  const [attempt,setAttempt]=useState(0)
  const router=useRouter()

  useEffect(()=>{
    let live=true
    async function initialize(){
      try{
        const sb=supabaseBrowser()
        const {data:sessionData,error:sessionError}=await sb.auth.getSession()
        if(sessionError)throw sessionError
        let session=sessionData.session
        if(!session && TEST_MODE){
          const {data,error:anonymousError}=await sb.auth.signInAnonymously({options:{data:{purpose:'max-v1-preview'}}})
          if(anonymousError)throw anonymousError
          session=data.session
        }
        if(!session){
          router.replace('/login')
          return
        }
        if(live){setError(false);setReady(true)}
      }catch{
        if(live){setError(true);setReady(false)}
      }
    }
    void initialize()
    return()=>{live=false}
  },[router,attempt])

  if(error) return <div className="page-loading"><div className="card" style={{width:'min(480px,calc(100% - 32px))'}}>
    <strong>Não foi possível iniciar a sessão de teste.</strong>
    <p className="muted">O acesso automático pode estar indisponível neste ambiente. Entre com uma conta existente ou tente novamente. Nenhum dado foi alterado por esta tentativa.</p>
    <div className="actions">
      <Link className="btn" href="/login">Entrar com conta</Link>
      <button className="btn secondary" onClick={()=>{setError(false);setAttempt(v=>v+1)}}>Tentar novamente</button>
    </div>
  </div></div>
  if(!ready) return <div className="page-loading" role="status" aria-live="polite">Carregando ambiente de testes…</div>
  return <>{children}</>
}
