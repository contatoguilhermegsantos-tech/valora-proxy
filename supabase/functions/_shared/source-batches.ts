export function sourceBatches(rows:any[],maxRows=20,maxBytes=32768) {
 const batches:any[][]=[];let batch:any[]=[],bytes=2;
 for(const row of rows){
  const size=new TextEncoder().encode(JSON.stringify(row)).length;
  if(size+2>maxBytes)throw new Error('Source record exceeds safe database payload limit');
  if(batch.length&&(batch.length>=maxRows||bytes+size+1>maxBytes)){batches.push(batch);batch=[];bytes=2}
  batch.push(row);bytes+=size+(batch.length>1?1:0);
 }
 if(batch.length)batches.push(batch);
 return batches;
}
