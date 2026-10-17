const labels:Record<string,string>={
 VERIFIED:'Verificado',CONFIRMED:'Confirmado',SUPPORTED:'Suporte contextual',UNRESOLVED:'Não resolvido',CAUTION:'Requer atenção',UNVALIDATED:'A validar',REVIEW:'Revisão necessária',REVIEW_REQUIRED:'Revisão necessária',
 CONNECTED:'Conector configurado',CONNECTED_LIMITED:'Conector com limites',MANUAL:'Consulta manual',UNAVAILABLE:'Indisponível',PENDING:'Pendente',BLOCKED:'Bloqueado',CONFIG_REQUIRED:'Configuração necessária',VALIDATING:'Em avaliação',CANDIDATE:'Candidato',
 RUNNING:'Em andamento',QUEUED:'Na fila',RETRY:'Nova tentativa',COMPLETED:'Concluído',PARTIAL:'Parcial',FAILED:'Falhou',CANCELLED:'Cancelado',SKIPPED:'Não executado',SUCCESS:'Concluído',MATCH:'Correspondência encontrada',NO_MATCH:'Sem correspondência',
 ACTIVE:'Ativo',INACTIVE:'Inativo',OPEN:'Aberto',RESOLVED:'Resolvido',REJECTED:'Descartado',CONTRADICTED:'Contradito',DISMISSED:'Descartado',STALE:'Desatualizado',HIGH:'Alta',MEDIUM:'Média',LOW:'Baixa',PASS:'Aprovado',WARN:'Com alertas',FAIL:'Falhou',
}
export function statusLabel(value?:string|null){return value?labels[value.toUpperCase()]||value:'—'}
export function statusTone(value?:string|null){
 const v=value?.toUpperCase()||''
 if(['VERIFIED','CONNECTED','COMPLETED','ACTIVE','CONFIRMED','HIGH','PASS','SUCCESS'].includes(v))return 'ok'
 if(['FAILED','REJECTED','CONTRADICTED','UNAVAILABLE','FAIL'].includes(v))return 'bad'
 if(['SUPPORTED','PENDING','RUNNING','QUEUED','RETRY','PARTIAL','BLOCKED','MANUAL','CONNECTED_LIMITED','UNRESOLVED','UNVALIDATED','CAUTION','REVIEW','REVIEW_REQUIRED','CONFIG_REQUIRED','VALIDATING','LOW','MEDIUM','OPEN','STALE','WARN'].includes(v))return 'pending'
 return 'neutral'
}
