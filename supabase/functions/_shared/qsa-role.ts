// QSA records both owners and officers. Presence in QSA alone never proves ownership.
export function qsaRelationshipType(role:unknown):'SOCIO'|'ADMINISTRADOR'|'QSA_PARTICIPANT'{
 const text=String(role||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
 if(/administrador|diretor|presidente|conselheiro de administracao/.test(text))return 'ADMINISTRADOR';
 if(/\bsocio\b|\bacionista\b|\btitular\b/.test(text))return 'SOCIO';
 return 'QSA_PARTICIPANT';
}
