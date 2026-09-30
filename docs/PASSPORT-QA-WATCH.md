# Perfil empresarial e correções do MAX QA Watch

30/09/2026 — somente max-v1 e backend de teste.

## Entrega
Perfil empresarial por empresa com cadastro jurídico, operação, estrutura societária, administração, eventos/publicações e documentação financeira. Cada item exige fonte verificada de apoio, identifica data/referência e informa lacunas. Capital social não conta como informação financeira suficiente; administrador cadastral não é automaticamente decisor financeiro. Empresas e eventos não são misturados entre núcleos.

## MAX QA Watch
- Checkpoints: alerta de tabela source_sync_checkpoints ausente não confirmado. O código/migration usa source_backfill_queue.next_page, presente no banco.
- PNCP: 33/33 DONE e cobertura até 29/09 confirmados. Cron agora só chama o worker se houver trabalho elegível ou lease expirado. Execução direta do comando do cron com a fila vazia retornou zero chamadas.
- Retentativas: removido reinício automático após quatro falhas. Item continua FAILED e exige reprocessamento explícito após diagnóstico.
- Banco: upserts divididos em lotes de no máximo 20 registros e 32 KiB. Checkpoint só avança após todos os lotes da página.
- CNPJ: atualização preserva revisão anterior; conteúdo novo recebe impressão digital própria, evitando anexar fatos novos a um documento antigo. Fonte cadastral com revisão pendente/rejeitada bloqueia geração automática. Eventos rejeitados não são restaurados.
- Interface: atualização da fila não redefine continuamente estratégia/CNPJ digitados.
- Credenciais: Brave e Portal continuam 428 CONFIG_REQUIRED. O usuário precisa cadastrar os secrets do backend; não foi possível ativar consultas reais sem eles.

## Validação e limites
38 testes passaram e build passou. Funções compiladas e implantadas no backend de teste. Guard de fila vazia verificado por execução real do SQL. A relação causal com timeouts do PostgREST ainda exige janela de observação; não declarar a causa raiz encerrada apenas por esta correção. O próximo dia elegível acorda automaticamente o worker; não desativamos a ingestão diária.

Branches/produção preservadas. Histórico completo de mudanças e revisão de expansão do grafo continuam como próximas entregas após o perfil empresarial.

Consulta real de atualização BrasilAPI retornou 502 (fonte indisponível ou timeout), sem fabricar resultado. Rejeição/pêndencia/desatualização foram verificadas executando o handler com transporte controlado; consulta real bem-sucedida da nova atualização ainda pendente. Consulta unificada de logs de timeout falhou no backend do conector; janela de estabilidade continua não confirmada.
