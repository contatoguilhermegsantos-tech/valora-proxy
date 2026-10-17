import {statusLabel,statusTone} from '@/lib/status-presentation'
export function StatusBadge({value}:{value?:string|null}){return <span className={`badge ${statusTone(value)}`}>{statusLabel(value)}</span>}
