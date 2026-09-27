export function StatusBadge({value}:{value?:string|null}){
  const v=(value||'—').toUpperCase()
  let cls='neutral'
  if(['VERIFIED','CONNECTED','COMPLETED','ACTIVE','CONFIRMED','SUPPORTED','HIGH'].includes(v)) cls='ok'
  else if(['FAILED','REJECTED','CONTRADICTED','UNAVAILABLE'].includes(v)) cls='bad'
  else if(['PENDING','RUNNING','RETRY','PARTIAL','BLOCKED','MANUAL','CONNECTED_LIMITED','UNRESOLVED','LOW','MEDIUM','OPEN'].includes(v)) cls='pending'
  return <span className={`badge ${cls}`}>{value||'—'}</span>
}
