// Public business names can contain a personal identifier, including MEI legal names.
// Keep business CNPJs and UUIDs; never use embedded personal identifiers as pivots.
export function familyNetworkText(value:unknown,max=300):string {
 if(typeof value!=='string')return '';
 return value.replace(/\*{2,}[.\s-]*\d[\d.\s-]{2,}\d[.\s-]*\*{2,}/g,'[identificador removido]')
  .replace(/(^|[^A-Za-z0-9])\d{3}[.\s]?\d{3}[.\s]?\d{3}[-\s]?\d{2}(?![A-Za-z0-9])/g,'$1[identificador removido]')
  .trim().slice(0,max);
}
