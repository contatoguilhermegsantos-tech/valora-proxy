# MAX: fontes, revisão da rede, histórico e descoberta comercial

Escopo: somente max-v1 e Supabase de teste. Main e produção preservadas.

## Entrega
- Fallback cadastral BrasilAPI → Base Empresarial, com estabelecimento exato, atribuição do provedor, documento imutável e preservação de revisão. Não utiliza CNPJ.ws, Brave ou Portal.
- Comparação de claims ignora diferenças de apresentação e respeita a empresa. Mudanças substantivas continuam gerando divergências. Caso real de QA restaurado com auditoria após detectar ATIVA/Ativa, MATRIZ/Matriz, DEM AIS/Demais e Barretos/BARRETOS.
- Fontes PNCP, CVM e BNDES preservam documentos e registros rejeitados, exigem vínculo da empresa no lead e bloqueiam VIEWER. BNDES e IPE falhados não representam ausência de registros. Central de Balanços grava em lotes menores.
- Revisão de relações com razão e auditoria transacional. Confirmação exige documento verificado, ausência de contradição e entidades resolvidas; atribuição ao lead e parentesco continuam exigindo seus próprios fluxos.
- Candidatos QSA pessoa jurídica aceitam CNPJ completo para validar nome, raiz, estabelecimento e QSA atual em dois cadastros. Fonte indisponível, candidato rejeitado ou QSA sem correspondência bloqueiam confirmação. Não se atribui o CNPJ ao lead original.
- Histórico persistente por lead, até 20 capturas recentes na interface; inicia agora, sem retroagir. Captura automática após pesquisa concluída/parcial; captura manual para revisão. IDs de evidência e datas de coleta não fabricam alterações; retorno A→B→A é preservado. Perda de suporte não é encerramento de sociedade ou de contrato.
- Oportunidades de crédito/ciclo de caixa, investimento, governança/decisão, continuidade e execução de contratos usam somente fatos com apoio verificado e sem contradição. Cada hipótese inclui pergunta, próxima validação, documentos e limites. Capital social não determina liquidez ou patrimônio.

## Validação
- Build local Next.js aprovado; testes automatizados de identidade, expansão, passaporte, fontes, oportunidades, histórico e permissões.
- API real: autenticação 401, recurso de outra organização 404, VIEWER 403 em oito funções; OWNER de QA restaurado.
- Banco real: leitura RLS por organização, escrita de snapshots pelo cliente bloqueada, RPC de revisão indisponível ao cliente; revisão de relação e auditoria confirmadas em transação revertida.
- Corpus real no workspace de QA: Hospital Village (saúde), WEG SA (indústria/holding) e SLC Agrícola (agro). Cadastros obtidos pelo fallback; sem dados financeiros inferidos ou contatos fabricados.
- Validação final do preview e do fluxo de captura está registrada no relatório local ao encerrar o bloco.

## Limites observados
- BrasilAPI: timeout a partir do Supabase e 403 em consulta direta; Base Empresarial respondeu às três consultas de QA. Disponibilidade externa continua sujeita a mudança.
- Querido Diário respondeu 503 na consulta direta. Não confundir falha com município sem cobertura.
- Brave e Portal permanecem sem credenciais, conforme orientação do usuário.
- PNCP: 33/33 datas DONE; cron ocioso não despacha worker. Ausência de novos timeouts PostgREST não foi confirmada: consulta aos logs retornou erro do serviço.
- QSA, porte, contratos e publicações não preenchem automaticamente receita, margem, caixa, dívida ou poderes de decisão. Documentos financeiros atuais e validação da empresa continuam necessários.
- Capturas refletem leituras do dossiê após a pesquisa; não são um registro retroativo nem prova de mudança econômica. Leituras de banco com erro impedem a captura.
