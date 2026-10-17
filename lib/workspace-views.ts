type Database = {from:(table:string)=>any;functions:{invoke:(name:string,options:{body:{action:string;limit:number}})=>Promise<any>}}
export type OverviewSnapshot = {
 stats:{leads:number;evidence:number;verified:number;divs:number};sources:any[];runs:any[]
}

export async function readWorkspaceOverview(sb:Database):Promise<OverviewSnapshot>{
 const results=await Promise.all([
  sb.from('leads').select('id',{count:'exact',head:true}),
  sb.from('evidence').select('id',{count:'exact',head:true}),
  sb.from('claims').select('id',{count:'exact',head:true}).eq('classification','FACT').eq('status','VERIFIED'),
  sb.from('divergences').select('id',{count:'exact',head:true}).eq('status','OPEN'),
  sb.from('source_registry').select('key,name,connection_status,source_tier').order('name'),
  sb.from('research_runs').select('id,lead_id,strategy,status,created_at,leads(name)').order('created_at',{ascending:false}).limit(6),
 ])
 if(results.some(r=>r.error)||results.slice(0,4).some(r=>!Number.isInteger(r.count)||r.count<0)||results.slice(4).some(r=>!Array.isArray(r.data)))
  throw new Error('Não foi possível atualizar a visão geral. Tente novamente.')
 return {stats:{leads:results[0].count,evidence:results[1].count,verified:results[2].count,divs:results[3].count},sources:results[4].data,runs:results[5].data}
}

export async function readWorkspaceResearch(sb:Database){
 const [runs,queue]=await Promise.all([
  sb.from('research_runs').select('*,leads(name),research_steps(*)').order('created_at',{ascending:false}).limit(100),
  sb.functions.invoke('research-queue',{body:{action:'list',limit:100}}),
 ])
 if(runs.error||queue.error||!Array.isArray(runs.data)||queue.data?.ok!==true||!Array.isArray(queue.data?.jobs))
  throw new Error('Não foi possível atualizar as pesquisas. O estado anterior foi preservado.')
 return {runs:runs.data,jobs:queue.data.jobs}
}
