// Read only three consolidated statement members; never inflate the annual archive.
type Entry = {name:string; method:number; flags:number; crc:number; compressed:number; size:number; offset:number};
type Fetcher = typeof fetch;
export type FinancialFact = {predicate:string; label:string; amount_brl:string; original_value:string; original_scale:string; account_code:string; period_start:string|null; period_end:string; reference_date:string; version:number; scope:'CONSOLIDATED'; unit:'BRL'; statement:string; cnpj:string; company_name:string};
const MAX_MEMBER_COMPRESSED=2*1024*1024, MAX_MEMBER_OUTPUT=32*1024*1024, TAIL_BYTES=65536;
const decoder=new TextDecoder('utf-8');
const normalized=(v:string)=>v.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().trim();
export const normalizeCnpj=(v:unknown)=>String(v??'').toUpperCase().replace(/[^A-Z0-9]/g,'');
const view=(b:Uint8Array)=>new DataView(b.buffer,b.byteOffset,b.byteLength);
const crcTable=Uint32Array.from({length:256},(_,n)=>{let c=n;for(let i=0;i<8;i++)c=c&1?0xedb88320^(c>>>1):c>>>1;return c>>>0});
function updateCrc(crc:number,bytes:Uint8Array){for(const byte of bytes)crc=crcTable[(crc^byte)&255]^(crc>>>8);return crc>>>0}
export function crc32(bytes:Uint8Array){return (updateCrc(0xffffffff,bytes)^0xffffffff)>>>0}

async function boundedBytes(r:Response,max:number){
 if(!r.body)throw new Error('CVM response has no body');
 const reader=r.body.getReader(),chunks:Uint8Array[]=[];let length=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>max)throw new Error('CVM range exceeds limit');chunks.push(value)}}catch(e){await reader.cancel().catch(()=>{});throw e}
 const result=new Uint8Array(length);let offset=0;for(const chunk of chunks){result.set(chunk,offset);offset+=chunk.length}return result;
}
async function range(url:string,start:number|null,end:number,fetcher:Fetcher,signal:AbortSignal,etag?:string,total?:number){
 const headers:Record<string,string>={Range:start===null?`bytes=-${end}`:`bytes=${start}-${end}`,Accept:'application/zip','User-Agent':'MAX-Intelligence/1.0'};
 if(etag)headers['If-Range']=etag;
 const r=await fetcher(url,{headers,signal});
 const m=r.headers.get('content-range')?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
 if(r.status!==206||!m){await r.body?.cancel().catch(()=>{});throw new Error('CVM does not provide validated partial content')}
 const first=Number(m[1]),last=Number(m[2]),size=Number(m[3]);
 if(size<=0||size>512*1024*1024||first<0||last<first||last>=size||total!==undefined&&size!==total||start!==null&&(first!==start||last!==end)||start===null&&(last!==size-1||first!==Math.max(0,size-end))){await r.body?.cancel().catch(()=>{});throw new Error('CVM Content-Range does not match request')}
 const actualEtag=r.headers.get('etag');
 if(!actualEtag||actualEtag.startsWith('W/')||etag&&actualEtag!==etag){await r.body?.cancel().catch(()=>{});throw new Error('CVM archive changed or has no strong ETag')}
 const bytes=await boundedBytes(r,last-first+1);
 if(bytes.length!==last-first+1)throw new Error('CVM partial response truncated');
 return {bytes,first,total:size,etag:actualEtag};
}
function directory(tail:Uint8Array,first:number,total:number):Entry[]{
 const d=view(tail);let eocd=-1;
 for(let i=tail.length-22;i>=0;i--)if(d.getUint32(i,true)===0x06054b50&&i+22+d.getUint16(i+20,true)===tail.length){eocd=i;break}
 if(eocd<0)throw new Error('CVM ZIP end directory not found');
 const count=d.getUint16(eocd+10,true),size=d.getUint32(eocd+12,true),offset=d.getUint32(eocd+16,true);
 if(d.getUint16(eocd+4,true)!==0||d.getUint16(eocd+6,true)!==0||count!==d.getUint16(eocd+8,true)||!count||count>64||offset<first||offset+size!==first+eocd||first+tail.length!==total)throw new Error('CVM ZIP directory unsupported');
 const entries:Entry[]=[];let p=offset-first;const names=new Set<string>();
 for(let i=0;i<count;i++){
  if(p+46>eocd||d.getUint32(p,true)!==0x02014b50)throw new Error('CVM ZIP directory corrupt');
  const n=d.getUint16(p+28,true),x=d.getUint16(p+30,true),c=d.getUint16(p+32,true),next=p+46+n+x+c;
  if(next>eocd||d.getUint16(p+34,true)!==0)throw new Error('CVM ZIP entry corrupt');
  const name=decoder.decode(tail.subarray(p+46,p+46+n));
  if(names.has(name))throw new Error('Duplicate CVM ZIP member');names.add(name);
  const entry={name,flags:d.getUint16(p+8,true),method:d.getUint16(p+10,true),crc:d.getUint32(p+16,true),compressed:d.getUint32(p+20,true),size:d.getUint32(p+24,true),offset:d.getUint32(p+42,true)};
  if(entry.offset+30+entry.compressed>offset||entry.flags&1)throw new Error('CVM ZIP member bounds invalid');
  entries.push(entry);p=next;
 }
 if(p!==eocd)throw new Error('CVM ZIP directory size mismatch');return entries;
}
export function parseCsvRecord(record:string){
 const fields:string[]=[];let value='',quoted=false;
 for(let i=0;i<record.length;i++){const c=record[i];if(c==='"'){if(quoted&&record[i+1]==='"'){value+='"';i++}else quoted=!quoted}else if(c===';'&&!quoted){fields.push(value.trim());value=''}else value+=c}
 if(quoted)throw new Error('CVM CSV quote incomplete');fields.push(value.trim());return fields;
}
function csvCollector(cnpj:string){
 let headers:string[]|null=null,pending='',quoted=false,record='',scanned=0;const rows:Record<string,string>[]=[];
 function accept(line:string){
  if(!line.trim())return;
  if(!headers){headers=parseCsvRecord(line).map(v=>normalized(v.replace(/^\uFEFF/,'')));if(headers[0]!=='CNPJ_CIA'||!['DT_REFER','VERSAO','MOEDA','ESCALA_MOEDA','ORDEM_EXERC','DT_FIM_EXERC','CD_CONTA','DS_CONTA','VL_CONTA','GRUPO_DFP'].every(k=>headers!.includes(k)))throw new Error('Unexpected CVM DFP columns');return}
  const first=parseCsvRecord(line.slice(0,line.indexOf(';')))[0];if(normalizeCnpj(first)!==cnpj)return;
  const fields=parseCsvRecord(line);if(fields.length!==headers.length)throw new Error('CVM matching row has invalid columns');
  rows.push(Object.fromEntries(headers.map((h,i)=>[h,fields[i]])));if(rows.length>5000)throw new Error('CVM matching row limit exceeded');
 }
 return {push(text:string,final=false){
  pending+=text;let start=0;
  // Most official rows contain no quotes. Keep embedded quoted newlines intact.
  for(let end=pending.indexOf('\n',start);end>=0;end=pending.indexOf('\n',start)){
   const line=pending.slice(start,end).replace(/\r$/,'');if(line.includes('"'))for(const c of line)if(c==='"')quoted=!quoted;
   record+=line;if(record.length>16384)throw new Error('CVM CSV record exceeds limit');
   if(!quoted){accept(record);record=''}else record+='\n';start=end+1;scanned++;
  }
  pending=pending.slice(start);if(pending.length+record.length>16384)throw new Error('CVM CSV record exceeds limit');
  if(final){if(pending){record+=pending;pending=''}if(quoted)throw new Error('CVM CSV incomplete record');if(record)accept(record);if(!headers||!scanned)throw new Error('CVM CSV missing rows')}
 },rows};
}
async function readMember(url:string,e:Entry,fetcher:Fetcher,signal:AbortSignal,etag:string,total:number,cnpj:string){
 if(e.method!==8||e.compressed<=0||e.compressed>MAX_MEMBER_COMPRESSED||e.size<=0||e.size>MAX_MEMBER_OUTPUT)throw new Error('CVM statement member exceeds supported limits');
 const head=await range(url,e.offset,e.offset+29,fetcher,signal,etag,total),d=view(head.bytes);
 if(d.getUint32(0,true)!==0x04034b50||d.getUint16(6,true)!==e.flags||d.getUint16(8,true)!==e.method)throw new Error('CVM ZIP local header mismatch');
 const nameLength=d.getUint16(26,true),extra=d.getUint16(28,true),prefix=nameLength+extra;
 if(prefix>4096||e.offset+30+prefix+e.compressed>total)throw new Error('CVM ZIP local member bounds invalid');
 const part=await range(url,e.offset+30,e.offset+29+prefix+e.compressed,fetcher,signal,etag,total);
 if(decoder.decode(part.bytes.subarray(0,nameLength))!==e.name)throw new Error('CVM ZIP local member name mismatch');
 const compressed=part.bytes.slice(prefix);
 const reader=new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
 const csv=csvCollector(cnpj),textDecoder=new TextDecoder('windows-1252');let length=0,crc=0xffffffff;
 try{for(;;){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>e.size||length>MAX_MEMBER_OUTPUT)throw new Error('CVM decompression exceeds declared output');crc=updateCrc(crc,value);csv.push(textDecoder.decode(value,{stream:true}))}}catch(error){await reader.cancel().catch(()=>{});throw error}
 if(length!==e.size||((crc^0xffffffff)>>>0)!==e.crc)throw new Error('CVM ZIP statement integrity mismatch');csv.push(textDecoder.decode(),true);return csv.rows;
}
export function scaleAmount(value:string,scale:string):string|null{
 if(!/^-?\d+(?:\.\d+)?$/.test(value))return null;
 const shift=normalized(scale)==='MIL'?3:normalized(scale)==='UNIDADE'?0:null;if(shift===null)return null;
 const negative=value.startsWith('-'),unsigned=negative?value.slice(1):value,[whole,fraction='']=unsigned.split('.');
 const digits=(whole+fraction.padEnd(shift,'0')).replace(/^0+(?=\d)/,'');const decimals=Math.max(0,fraction.length-shift);
 const integral=(decimals?digits.slice(0,-decimals)||'0':digits).replace(/^0+(?=\d)/,''),decimal=(decimals?digits.slice(-decimals).padStart(decimals,'0'):'').replace(/0+$/,'');
 const amount=integral+(decimal?'.'+decimal:'');return (negative&&amount!=='0'?'-':'')+amount;
}
const date=(s:string)=>/^\d{4}-\d{2}-\d{2}$/.test(s)&&Number.isFinite(Date.parse(s))&&new Date(s).toISOString().slice(0,10)===s;
function eligibleRows(rows:Record<string,string>[],cnpj:string,year:number){
 return rows.filter(r=>normalizeCnpj(r.CNPJ_CIA)===cnpj&&r.DT_REFER?.startsWith(year+'-')&&date(r.DT_REFER)&&r.DT_FIM_EXERC===r.DT_REFER&&normalized(r.ORDEM_EXERC)==='ULTIMO'&&normalized(r.GRUPO_DFP).startsWith('DF CONSOLIDADO')&&/^\d+$/.test(r.VERSAO));
}
function latestVersions(rows:Record<string,string>[]){
 const versions=new Map<string,number>();for(const r of rows)versions.set(r.DT_REFER,Math.max(versions.get(r.DT_REFER)??0,Number(r.VERSAO)));return versions;
}
export function extractFinancialFacts(rows:Record<string,string>[],cnpj:string,year:number,statement:string):FinancialFact[]{
 const account:Record<string,{predicate:string;label:RegExp}>={BPA_1:{predicate:'total_assets',label:/^ativo total$/i},'BPA_1.01':{predicate:'current_assets',label:/^ativo circulante$/i},'BPA_1.01.01':{predicate:'cash_balance',label:/^caixa e equivalentes de caixa$/i},'BPP_2.01':{predicate:'current_liabilities',label:/^passivo circulante$/i},'BPP_2.03':{predicate:'equity',label:/^patrimonio liquido/i},'DRE_3.01':{predicate:'revenue',label:/^receita de venda de bens e\/?ou servicos$/i},'DRE_3.11':{predicate:'net_income',label:/^lucro\/prejuizo consolidado do periodo$/i}};
 const candidates=eligibleRows(rows,cnpj,year),versions=latestVersions(candidates);
 const result:FinancialFact[]=[],seen=new Map<string,string>();
 for(const r of candidates){
  if(Number(r.VERSAO)!==versions.get(r.DT_REFER))continue;const mapped=account[statement+'_'+r.CD_CONTA];if(!mapped||!mapped.label.test(normalized(r.DS_CONTA))||normalized(r.MOEDA)!=='REAL'||r.ST_CONTA_FIXA!=='S'||!date(r.DT_REFER))continue;
  const start=r.DT_INI_EXERC||null;if(statement==='DRE'&&(!start||!date(start)||start>r.DT_FIM_EXERC))continue;
  const amount=scaleAmount(r.VL_CONTA,r.ESCALA_MOEDA);if(amount===null)continue;
  const key=r.DT_REFER+'|'+mapped.predicate;if(seen.has(key)){if(seen.get(key)!==amount)throw new Error('Conflicting CVM financial rows');continue}seen.set(key,amount);
  result.push({predicate:mapped.predicate,label:r.DS_CONTA,amount_brl:amount,original_value:r.VL_CONTA,original_scale:r.ESCALA_MOEDA,account_code:r.CD_CONTA,period_start:start,period_end:r.DT_FIM_EXERC,reference_date:r.DT_REFER,version:Number(r.VERSAO),scope:'CONSOLIDATED',unit:'BRL',statement,cnpj,company_name:r.DENOM_CIA});
 }
 return result;
}
export async function fetchDfpFinancials(cnpj:string,year:number,fetcher:Fetcher=fetch,now=new Date()){
 cnpj=normalizeCnpj(cnpj);if(!/^[A-Z0-9]{12}\d{2}$/.test(cnpj))throw new Error('Valid full CNPJ required');
 if(!Number.isInteger(year)||year<2010||year>=now.getUTCFullYear())throw new Error('Closed reference year required');
 const url=`https://dados.cvm.gov.br/dados/CIA_ABERTA/DOC/DFP/DADOS/dfp_cia_aberta_${year}.zip`,signal=AbortSignal.timeout(60000);
 const tail=await range(url,null,TAIL_BYTES,fetcher,signal),entries=directory(tail.bytes,tail.first,tail.total),facts:FinancialFact[]=[],members:string[]=[],versions=new Map<string,Set<number>>();
 for(const statement of ['BPA','BPP','DRE']){
  const name=`dfp_cia_aberta_${statement}_con_${year}.csv`,entry=entries.find(e=>e.name===name);if(!entry)throw new Error('CVM consolidated statement member missing');
  const rows=await readMember(url,entry,fetcher,signal,tail.etag,tail.total,cnpj);
  // Version belongs to the statement, including accounts outside the selected metrics.
  for(const [period,version] of latestVersions(eligibleRows(rows,cnpj,year))){const set=versions.get(period)||new Set<number>();set.add(version);versions.set(period,set)}
  facts.push(...extractFinancialFacts(rows,cnpj,year,statement));members.push(name);
 }
 if([...versions.values()].some(set=>set.size>1))throw new Error('CVM statements have inconsistent versions for one reporting period');
 return {cnpj,year,source_url:url,archive_etag:tail.etag,archive_bytes:tail.total,members,facts,complete:true,scope:'CONSOLIDATED'};
}
