# Expansão de núcleos e preparação comercial

## Comportamento

- Expandir uma empresa mantém seu CNPJ e inicia a investigação quando o núcleo está vazio. Um identificador estável impede duplicação em expansões concorrentes.
- Núcleos empresariais legados recuperam o CNPJ pelo vínculo único ativo. Pessoas nunca recebem automaticamente o CNPJ da empresa de origem.
- A expansão verifica membro ativo, permissão de escrita e presença da entidade no grafo do lead da mesma organização.
- Dossiê mostra retorno ao lead de origem. Falha ao enfileirar oferece acesso ao dossiê para tentar novamente.
- Evidências dos conectores CNPJ, BNDES, PNCP, CVM, IPE, Central de Balanços e Querido Diário são deduplicadas por lead. Documentos históricos referenciados por fatos/relações são carregados dentro da mesma organização.
- Cadastro passa a incluir início de atividade, natureza jurídica, porte, matriz/filial, capital social e atividades secundárias quando publicados pela fonte.
- Preparação comercial organiza fatos por empresa e propõe temas de operação/governança e sinais já documentados, sempre com evidências, perguntas e limitações. Sinais sem suporte verificado não são incluídos.
- Pesquisas com etapas parciais/bloqueadas passam a registrar PARTIAL corretamente; uma coluna inexistente impedia o cálculo anterior.

## QA

- 14 testes unitários aprovados: identidade, recuperação de CNPJ, não atribuição de CNPJ a pessoa, isolamento de identificadores, exclusão de suporte rejeitado/contradito.
- API real: duas expansões concorrentes retornaram o mesmo lead com CNPJ e pesquisa automática.
- Empresa investigada: dez fatos e oito relações QSA. Consultas profundas executadas; ausência de achados ou cobertura continua explícita.
- Reabertura reutiliza o núcleo sem repetir uma pesquisa já materializada.
- Lead principal manteve suas evidências após investigação do filho.
- Empresa → pessoa inicia núcleo próprio sem confirmar a identidade individual nem herdar CNPJ.
- Núcleo legado sem CNPJ recupera identificador no enfileiramento.
- VIEWER recebe 403; outro workspace recebe 404.
- Snapshot após QA: zero violações críticas e zero alertas.

## Limitações

Esta entrega não ativa fontes dependentes de credenciais e não interpreta automaticamente o conteúdo completo de balanços. A camada comercial é baseada em regras e documentos disponíveis; perguntas de descoberta não são oportunidades financeiras comprovadas. Dados públicos podem continuar insuficientes para faturamento, margem, dívida atual, liquidez ou histórico completo. Personificação por homônimos permanece sujeita à resolução de identidade.


