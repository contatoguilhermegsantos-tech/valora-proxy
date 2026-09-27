import './globals.css'
import type { Metadata } from 'next'
export const metadata: Metadata = { title:'MAX Intelligence', description:'Inteligência comercial baseada em evidências' }
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="pt-BR"><body>{children}</body></html>}
