'use client'
import {StatusBadge} from './StatusBadge'
type Source={id:string;source_name:string;source_url:string|null;intended_use:string;auth_requirement:string;coverage_notes:string;limitations:string;status:string;priority:number;official_or_primary:boolean}
export function SourceBacklog({rows}:{rows:Source[]}){
 return <div className="card section"><h3>Fontes candidatas — backlog</h3><p className="muted">Fontes em avaliação ou aguardando integração. Uma fonte candidata não conta como cobertura disponível.</p>{rows.length?<div className="table-wrap"><table className="table"><thead><tr><th>Prioridade / fonte</th><th>Uso previsto</th><th>Status e dependência</th><th>Limitações</th></tr></thead><tbody>{rows.map(s=><tr key={s.id}><td><strong>{s.priority} · {s.source_name}</strong><div className="micro">{s.official_or_primary?'Fonte oficial ou primária':'Fonte complementar'}</div>{s.source_url&&/^https?:\/\//.test(s.source_url)&&<a className="source-link" href={s.source_url} target="_blank" rel="noreferrer">Consultar fonte ↗</a>}</td><td>{s.intended_use}<div className="micro">{s.coverage_notes}</div></td><td><StatusBadge value={s.status}/><div className="micro">{s.auth_requirement}</div></td><td>{s.limitations}</td></tr>)}</tbody></table></div>:<div className="empty">Nenhuma fonte candidata registrada.</div>}</div>
}

