export function normalizeCnpj(value: unknown){
  return String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g,'')
}

export function isValidCnpj(value: unknown){
  const c=normalizeCnpj(value)
  if(!/^[A-Z0-9]{12}[0-9]{2}$/.test(c)) return false
  const val=(ch:string)=>ch.charCodeAt(0)-48
  const calc=(base:string,weights:number[])=>{
    const sum=[...base].reduce((acc,ch,i)=>acc+val(ch)*weights[i],0)
    const rem=sum%11
    return rem<2?0:11-rem
  }
  const d1=calc(c.slice(0,12),[5,4,3,2,9,8,7,6,5,4,3,2])
  if(d1!==Number(c[12])) return false
  const d2=calc(c.slice(0,12)+String(d1),[6,5,4,3,2,9,8,7,6,5,4,3,2])
  return d2===Number(c[13])
}

export function formatCnpj(value: unknown){
  const c=normalizeCnpj(value)
  if(c.length!==14) return c
  return `${c.slice(0,2)}.${c.slice(2,5)}.${c.slice(5,8)}/${c.slice(8,12)}-${c.slice(12)}`
}
