# Operação das fontes — 29/09/2026

Escopo: max-v1 e projeto de testes do MAX. Sem promoção para produção.

## Correções

- Querido Diário usa o domínio da documentação atual, api.queridodiario.org.br. O endereço anterior apresentou falha TLS; o atual respondeu 503 na validação. Não houve desativação da validação de certificado.
- Consultas possuem prazo de 8 segundos e no máximo duas tentativas. Falhas permanentes e limites com espera longa não recebem tentativas imediatas adicionais.
- Falha de rede, resposta inválida, cidade ambígua, município fora de cobertura confirmada e pesquisa sem menções são resultados distintos. Registros antigos CITY_NOT_COVERED são inconclusivos.
- Nome exato e UF são obrigatórios para a correspondência quando a UF é conhecida. Não se escolhe o primeiro município de uma lista.
- Reconsulta não altera evidências existentes; revisões humanas, inclusive rejeições, são preservadas. Vínculos rejeitados não geram termos de pesquisa. Membros inativos e VIEWER não podem gravar pesquisa.
- Fontes exibe saúde observada apenas na organização ativa: amostra das 500 consultas mais recentes em 48 horas, erros, resultado e horário. Metadados compartilhados de sincronização e autoauditoria aparecem separados. Nenhuma consulta recente não significa fonte saudável. Botão de atualização apenas relê o status.
- PNCP: cron diário enfileira datas faltantes, até 31 dias por recuperação; worker existente a cada 10 minutos processa até cinco páginas fixas de 100 registros. Página só avança após gravar contratos. Não muda tamanho durante paginação. Resposta vazia/inválida deixa data incompleta.
- Claim de data por atualização condicional evita dois workers no mesmo item. Execução interrompida recupera após 10 minutos. Quatro falhas consecutivas impõem seis horas de espera antes de novas tentativas. Progresso salva página e reinicia contagem de falhas.
- Cobertura PNCP só avança por datas contíguas concluídas. Reparação de lacuna também recupera datas posteriores já concluídas. A página final pode ser reprocessada com upsert sem duplicar contratos.

## Verificação

- Build Next.js concluído com validação de tipos.
- 26 testes automatizados: identidade, expansão, saúde das fontes e handlers do PNCP. Testes de handler executam código real com transporte/banco em memória: bloqueio 429 na segunda página, retomada, término, dois workers simultâneos, lease interrompida e cooldown.
- API real: autenticação ausente 401; lead de outra organização 404; VIEWER 403. Papel do usuário de QA restaurado após o teste.
- Querido Diário real retornou 502/CITY_LOOKUP_FAILED, identificando HTTP 503 da fonte. O painel de saúde devolveu FAILURE, sem converter isso em ausência de cobertura.
- PNCP real preservou a data de cobertura 27/09 e a fila do dia 28/09 após NETWORK_ERROR. Recuperação com páginas reais permanece dependente do retorno da fonte externa; não foi declarada como aprovada.
- Autoauditoria em 29/09 22:17 UTC: PASS, zero violações e alertas.

## Limites e operação

Existem 19 fontes cadastradas: sete CONNECTED, três CONNECTED_LIMITED, quatro PENDING, quatro MANUAL e uma UNAVAILABLE. Cadastro de conexão não equivale a teste recente. PNCP possui sincronização diária; demais conectores rodam conforme a pesquisa, e fontes manuais não são simuladas como automáticas.

Busca web ampla e Portal da Transparência dependem de credenciais específicas; CADE depende de acesso autorizado, JUCESP/DOU/fontes corporativas exigem fluxo documental e a base própria de CNPJ ainda depende de indexação. Brapi sem token tem cobertura de demonstração. Não adicionar credenciais ao código, relatórios ou chat.

Contratos e publicações não demonstram pagamento, lucro, liquidez ou patrimônio pessoal. Indisponibilidade e ausência de cobertura não demonstram inexistência de atividade comercial.

Documentação primária consultada: https://api.queridodiario.org.br/docs e https://www.gov.br/pncp/pt-br/acesso-a-informacao/dados-abertos.
