type Source = {key:string;name?:string;connection_status?:string;action_url?:string;limitations?:string};
type Route = {key:string;question:string;steps:string[];providers:{key:string;fn?:string;credential?:string}[];requiresCompany:boolean;limit:string;next:string};
export function normalizeResearchStep<T extends {source_key?:string;result_summary?:string;action_url?:string}>(step:T) {
 if(step.source_key!=='querido_diario')return step;
 return {...step,action_url:'https://api.queridodiario.org.br/docs',result_summary:String(step.result_summary||'').includes('Município não está coberto/localizado')?'Resultado legado inconclusivo. Reexecute a investigação para confirmar a cobertura municipal.':step.result_summary};
}
export const SOURCE_ROUTES:Route[] = [
 {key:'company_discovery',question:'Quais empresas podem corresponder a esta pessoa?',steps:['name_discovery'],providers:[{key:'base_empresarial_rfb',fn:'name-company-discovery'}],requiresCompany:false,limit:'Nome e localidade produzem candidatos; homônimos precisam de validação.',next:'Revisar candidatos e investigar cada empresa em seu próprio núcleo.'},
 {key:'company_registry',question:'Qual é o cadastro e o quadro societário deste CNPJ?',steps:['cnpj_qsa'],providers:[{key:'brasilapi_cnpj',fn:'cnpj-enrich'},{key:'base_empresarial_rfb',fn:'cnpj-enrich'}],requiresCompany:true,limit:'O conector tenta BrasilAPI e utiliza Base Empresarial como alternativa. QSA não comprova controle final, parentesco ou poderes financeiros.',next:'Consultar cadastro e revisar vínculos documentados; validar controle e poderes por atos societários.'},
 {key:'financial_documents',question:'Há demonstrações financeiras publicadas?',steps:['financial_filings'],providers:[{key:'central_balancos_sped',fn:'central-balancos-search'}],requiresCompany:true,limit:'Documento localizado não equivale a receita, dívida ou liquidez extraída e validada.',next:'Consultar publicações e validar o conteúdo das demonstrações atuais com a empresa.'},
 {key:'municipal_mentions',question:'Há menções nos Diários Oficiais municipais consultados?',steps:['municipal_gazettes'],providers:[{key:'querido_diario',fn:'querido-diario-search'}],requiresCompany:false,limit:'Cobertura municipal limitada; erro de consulta não significa ausência de menções.',next:'Reconsultar quando disponível ou pesquisar diretamente o diário oficial do município.'},
 {key:'financing',question:'Há operações publicadas nas bases do BNDES?',steps:['bndes_financing'],providers:[{key:'bndes_financing',fn:'bndes-company-financing'}],requiresCompany:true,limit:'Operação publicada não determina dívida atual, saldo ou capacidade financeira.',next:'Consultar operações e solicitar posição financeira atual para aprofundar.'},
 {key:'public_contracts',question:'Há contratos na cobertura indexada do PNCP?',steps:['public_contracts'],providers:[{key:'pncp',fn:'pncp-company-contracts'}],requiresCompany:true,limit:'Cobertura indexada é um recorte. Contrato não prova pagamento ou margem.',next:'Consultar contratos e conferir período coberto e execução dos contratos relevantes.'},
 {key:'federal_records',question:'Há contratos e registros administrativos federais?',steps:['federal_transparency'],providers:[{key:'portal_transparencia',fn:'portal-transparencia-company',credential:'portal'}],requiresCompany:true,limit:'Cobertura federal específica; não substitui o PNCP nem representa toda a atividade da empresa.',next:'Aguardar configuração da fonte; permanece desativada nesta etapa.'},
 {key:'listed_company',question:'Este CNPJ consta no cadastro consultado da CVM?',steps:['cvm'],providers:[{key:'cvm',fn:'cvm-company-check'}],requiresCompany:true,limit:'Resultado vale para este CNPJ; uma marca ou grupo pode possuir outro CNPJ listado.',next:'Verificar cadastro e manter separadas entidade jurídica, marca e grupo.'},
 {key:'corporate_filings',question:'Há publicações corporativas no IPE/CVM?',steps:['cvm_ipe'],providers:[{key:'cvm_ipe',fn:'cvm-ipe-search'}],requiresCompany:true,limit:'Depende da aplicabilidade CVM; o recorte anual não representa todo o histórico societário.',next:'Consultar os anos previstos para companhias elegíveis; conferir os documentos originais.'},
 {key:'corporate_history',question:'Há alterações societárias e de estrutura documentadas?',steps:['corporate_history'],providers:[{key:'jucesp'}],requiresCompany:true,limit:'Junta estadual exige fluxo documental próprio. QSA atual não reconstrói o histórico.',next:'Obter atos na Junta competente pela sede da empresa; JUCESP atende São Paulo.'},
 {key:'mna',question:'Há ato de concentração ou transação documentada?',steps:['mna'],providers:[{key:'cade'}],requiresCompany:true,limit:'Nem toda transação aparece no CADE; anúncio não comprova fechamento ou liquidez pessoal.',next:'Pesquisar atos e documentos originais; confirmar participantes e estágio da transação.'},
 {key:'web_context',question:'Há contexto público complementar que merece verificação?',steps:['web_context','family_validation'],providers:[{key:'web_search',fn:'web-context-search',credential:'brave'}],requiresCompany:false,limit:'Resultados web são pistas para revisão, sem confirmação automática de fatos.',next:'Aguardar configuração da busca web; nenhuma relação familiar é inferida pelo sobrenome.'}
];

export function buildSourceRoutes(sources:Source[],context:{companyResolved:boolean;kind?:string;braveConfigured?:boolean;portalConfigured?:boolean}) {
 const byKey=new Map(sources.map(s=>[s.key,s]));
 return SOURCE_ROUTES.filter(r=>!(context.kind==='COMPANY'&&r.key==='company_discovery')).map(route=>{
  const providers=route.providers.map(p=>{
   const source=byKey.get(p.key);
   const configured=!p.credential||(p.credential==='brave'?context.braveConfigured:context.portalConfigured)===true;
   const connected=!!source&&['CONNECTED','CONNECTED_LIMITED'].includes(source.connection_status||'');
   const enabled=!!p.fn&&configured&&(connected||!!p.credential);
   const reason=!p.fn?'MANUAL':!configured?'CONFIG_REQUIRED':!connected&&!p.credential?'UNAVAILABLE':'READY';
   return {key:p.key,name:source?.name||p.key,fn:p.fn||null,enabled,reason,action_url:source?.action_url||null,limitations:source?.limitations||null};
  });
  const prerequisite=route.requiresCompany&&!context.companyResolved;
  return {...route,providers,state:prerequisite?'NEEDS_COMPANY':providers.some(p=>p.enabled)?'READY':providers.some(p=>p.reason==='CONFIG_REQUIRED')?'CONFIG_REQUIRED':providers.every(p=>p.reason==='MANUAL')?'MANUAL':'UNAVAILABLE',selected:prerequisite?null:providers.find(p=>p.enabled)?.fn||null};
 });
}

// Run only independent operations together. CVM eligibility must finish before IPE.
export async function runIndependent<T>(items:T[],run:(item:T)=>Promise<void>) {
 for(let i=0;i<items.length;i+=2){
  const results=await Promise.allSettled(items.slice(i,i+2).map(run));
  const failure=results.find(r=>r.status==='rejected');
  if(failure?.status==='rejected')throw failure.reason;
 }
}
