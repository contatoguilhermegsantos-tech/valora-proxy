type Attempt={attempt:number;status:number|null;error:string|null;duration_ms:number;retry_after_seconds:number|null};
type Options={fetcher?:typeof fetch;clock?:()=>number;wait?:(ms:number)=>Promise<void>;deadline?:number};
export const QUERIDO_DIARIO_API='https://api.queridodiario.org.br';

function retryDelay(header:string|null,now:number){
 if(!header)return null;
 const seconds=/^\d+$/.test(header)?Number(header):(Date.parse(header)-now)/1000;
 return Number.isFinite(seconds)&&seconds>=0?Math.ceil(seconds):null;
}
async function boundedJson(response:Response){
 const reader=response.body?.getReader();if(!reader)throw Error('INVALID_RESPONSE');const parts:Uint8Array[]=[];let size=0;
 try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>1024*1024)throw Error('RESPONSE_TOO_LARGE');parts.push(part.value)}}
 catch(e){await reader.cancel().catch(()=>{});throw e}finally{reader.releaseLock()}
 const bytes=new Uint8Array(size);let at=0;for(const part of parts){bytes.set(part,at);at+=part.byteLength}
 try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))}catch{throw Error('INVALID_RESPONSE')}
}

// Two attempts at most, on the same public source. The caller owns a shared round deadline.
// No redirects, bearer headers, source bodies or query values enter diagnostics.
export async function fetchQueridoDiarioJson(url:string,valid:(value:any)=>boolean,options:Options={}){
 const target=new URL(url);if(target.origin!==QUERIDO_DIARIO_API||!['/cities','/gazettes'].includes(target.pathname))throw Error('Unsupported Querido Diário endpoint');
 const fetcher=options.fetcher||fetch,clock=options.clock||Date.now,wait=options.wait||((ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms))),deadline=options.deadline??clock()+16500;
 const attempts:Attempt[]=[];let result:{ok:boolean;status:number|null;data:any;error:string|null}={ok:false,status:null,data:null,error:'DEADLINE'},retryAfter:number|null=null;
 for(let attempt=1;attempt<=2;attempt++){
  if(clock()+50>=deadline)break;
  const started=clock();let currentRetry:number|null=null;
  try{
   const response=await fetcher(url,{headers:{Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(Math.max(1,Math.min(8000,Math.floor(deadline-clock()))))});
   currentRetry=response.ok?null:retryDelay(response.headers.get('Retry-After'),clock());
   if(response.status===429&&currentRetry===null)currentRetry=60;
   if(currentRetry!==null)retryAfter=Math.max(retryAfter||0,currentRetry);
   if(response.ok){
    try{const data=await boundedJson(response);result=valid(data)?{ok:true,status:response.status,data,error:null}:{ok:false,status:response.status,data:null,error:'INVALID_RESPONSE'}}
    catch(e){const error=e as Error;result={ok:false,status:response.status,data:null,error:['TimeoutError','AbortError'].includes(error.name)?'TIMEOUT':['INVALID_RESPONSE','RESPONSE_TOO_LARGE'].includes(error.message)?error.message:'INVALID_RESPONSE'}}
   }else{await response.body?.cancel();result={ok:false,status:response.status,data:null,error:'HTTP_'+response.status}}
  }catch(e){const error=e as Error;result={ok:false,status:null,data:null,error:['TimeoutError','AbortError'].includes(error.name)?'TIMEOUT':'NETWORK_ERROR'}}
  attempts.push({attempt,status:result.status,error:result.error,duration_ms:Math.max(0,clock()-started),retry_after_seconds:currentRetry});
  const transient=['TIMEOUT','NETWORK_ERROR','HTTP_408','HTTP_425','HTTP_500','HTTP_502','HTTP_503','HTTP_504'].includes(result.error||'');
  if(result.ok||!transient||attempt===2||currentRetry!==null&&currentRetry>2)break;
  const delay=Math.max(500,(currentRetry||0)*1000);if(clock()+delay+50>=deadline)break;await wait(delay);
 }
 return {...result,attempts,retry_after_seconds:retryAfter};
}
