export type ResearchJob = {
 id:string; lead_id?:string; organization_id?:string; job_type?:string; status:string;
 strategy?:string; created_at?:string; updated_at?:string; next_attempt_at?:string;
 attempts?:number; max_attempts?:number; last_error?:string|null;
 progress?:Record<string,any>|null; result?:Record<string,any>|null;
}
export type ResearchStep = {id:string; step_order:number; title:string; status:string; result_summary?:string|null; error_summary?:string|null; action_url?:string|null}
export type ResearchRun = {id:string; lead_id?:string; organization_id?:string; strategy?:string; status:string; research_steps?:ResearchStep[]; counters?:Record<string,any>; created_at?:string}
export const isResearchId=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
export const isActiveResearch=(job:ResearchJob|null|undefined)=>!!job&&['PENDING','RUNNING','RETRY'].includes(job.status)

export function inferResearchStrategy(lead:{kind?:string;segment?:string|null}){
 const segment=String(lead.segment||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase()
 return /agro|rural|fazenda|pecu|agric/.test(segment)?'AGRO':/medic|saude|clinic|hospital/.test(segment)?'MEDICO':lead.kind==='COMPANY'?'EMPRESARIO':'GENERICO'
}
export function pickEnqueuedResearch(data:any,leadId:string):ResearchJob{
 if(data?.ok!==true)throw new Error(data?.error||'O MAX não confirmou o início da pesquisa. Tente novamente.')
 const rows=[...(Array.isArray(data.created)?data.created:[]),...(Array.isArray(data.existing)?data.existing:[])]
 const job=rows.find(row=>isResearchId(row?.id)&&(!row.lead_id||row.lead_id===leadId)&&(!row.job_type||row.job_type==='LEAD_RESEARCH'))
 if(!job)throw new Error('O lead foi salvo, mas nenhuma execução de pesquisa foi confirmada. Tente iniciar novamente.')
 return {...job,lead_id:leadId}
}
export function selectResearchJob(jobs:ResearchJob[],leadId:string,jobId?:string|null,organizationId?:string):ResearchJob|null{
 const own=jobs.filter(job=>isResearchId(job.id)&&job.lead_id===leadId&&(!organizationId||job.organization_id===organizationId)&&(!job.job_type||job.job_type==='LEAD_RESEARCH'))
 if(jobId)return own.find(job=>job.id===jobId)||null
 return [...own].filter(isActiveResearch).sort((a,b)=>String(b.created_at||'').localeCompare(String(a.created_at||'')))[0]||null
}
export function linkedResearchRun(job:ResearchJob|null,runs:ResearchRun[],leadId:string,organizationId?:string):ResearchRun|null{
 const id=job?.progress?.research_run_id||job?.result?.research_run_id
 if(!isResearchId(id))return null
 return runs.find(run=>run.id===id&&run.lead_id===leadId&&(!organizationId||run.organization_id===organizationId))||null
}
export function researchOutcome(job:ResearchJob|null,run:ResearchRun|null){
 if(!job)return 'missing' as const
 if(job.status==='FAILED')return 'failed' as const
 if(job.status==='CANCELLED')return 'cancelled' as const
 if(isActiveResearch(job))return 'active' as const
 if(job.status!=='COMPLETED')return 'missing' as const
 if(!run||!['COMPLETED','PARTIAL','FAILED'].includes(run.status))return 'waiting_results' as const
 if(run.status==='FAILED')return 'failed' as const
 return run.status==='PARTIAL'||job.progress?.research_status==='PARTIAL'?'partial' as const:'completed' as const
}
export function researchStepSummary(steps:ResearchStep[]=[]){
 const counts={total:steps.length,settled:0,completed:0,partial:0,blocked:0,failed:0,skipped:0,running:0,pending:0}
 for(const step of steps){
  const key=step.status.toLowerCase() as keyof typeof counts
  if(key in counts&&key!=='total'&&key!=='settled')counts[key]++
  if(['COMPLETED','PARTIAL','BLOCKED','FAILED','SKIPPED','CANCELLED'].includes(step.status))counts.settled++
 }
 return counts
}
export function researchSourceUrl(value:unknown){
 try{const url=new URL(String(value));return url.protocol==='https:'&&!url.username&&!url.password?url.href:null}catch{return null}
}
export function researchHref(leadId:string,jobId?:string|null,enqueueFailed=false){
 const query=new URLSearchParams({mode:'research'})
 if(isResearchId(jobId))query.set('job',jobId)
 if(enqueueFailed)query.set('issue','enqueue')
 return `/leads/${encodeURIComponent(leadId)}?${query}`
}
