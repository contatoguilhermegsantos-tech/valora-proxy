# Revisão QSA e diagnóstico de fontes

Escopo: `max-v1` e Supabase de teste. O fluxo empresarial por razão social/fantasia permanece separado do QSA de pessoa. Confirmar um vínculo empresarial não confirma parentesco, outros CNPJs, localização pessoal ou capacidade financeira.

## Comportamento

- A descoberta grava uma citação imutável antes do candidato, com o CNPJ completo, raiz, nome QSA e consulta. O candidato referencia esse documento explicitamente.
- Um candidato antigo sem essa referência exige reconsulta canônica. Confirmações humanas históricas e documentos existentes são preservados; não há associação automática com o documento mais recente.
- Confirmação consulta o cadastro primeiro e só depois aplica revisão, vínculo, identidade e avaliação numa transação. Documento fora do escopo, revisado, CNPJ divergente ou contexto alterado bloqueiam a confirmação.
- Descarte preserva outros vínculos confirmados, dados manuais e documentos. Reconsulta, score e validação cruzada não reabrem descartes nem alteram os CNPJs/documentos de uma revisão humana.
- Enriquecimento do núcleo empresarial verifica o estado atual após a consulta externa. Qualquer relação rejeitada ou contradita bloqueia a atribuição, inclusive quando existem relações duplicadas.
- Avaliação usa comparação do estado e metadados atuais; avaliação, candidato e estado do lead são gravados juntos. Documentos inválidos resultam em revisão com score zero. `SUPPORTED` continua exigindo confirmação humana.
- Querido Diário distingue timeout, erro de rede, resposta HTTP e contrato inválido; preserva `Retry-After`, resultados parciais e vínculo com a execução. Somente documentos `PENDING` ou `VERIFIED` contam como menções. Menção não vira fato automaticamente.

## Validação

- 349 testes automatizados aprovados; build Next.js e verificação de tipos aprovados.
- 94 controles independentes executados no banco de teste em transação com rollback: escopo, documentos atuais/legados, acesso, decisões concorrentes simuladas por snapshots obsoletos, idempotência, multiempresa, duplicatas e preservação de vínculos manuais. Nenhuma fixture transitória permaneceu.
- Concorrência real entre requisições não é afirmada por esses controles de snapshots obsoletos.
- Os testes de contrato não garantem disponibilidade externa nem cobertura completa de uma fonte.

## Fechamento hospedado e autoauditoria

- QA HTTP no ambiente de teste: descoberta concluiu com cinco candidatos não validados; confirmação explícita de um CNPJ verificou somente o vínculo selecionado. Reconsulta preservou documento, CNPJ e decisão humana. Descarte seguido de reavaliação retornou a identidade para cautela, preservou 11 fatos empresariais e dez documentos, sem criar parentesco ou localização pessoal.
- Sete controles HTTP de autenticação/escopo foram aprovados. A restrição de operador `VIEWER` foi coberta em SQL e testes de contrato; não se afirma um teste HTTP desse papel.
- Diagnóstico real do Querido Diário concluiu parcialmente: uma consulta respondeu HTTP 200 e outra respondeu HTTP 503 nas duas tentativas. A falha continuou identificada como indisponibilidade, sem virar ausência de menções ou fato.
- A consulta de invariantes excedia o limite existente de oito segundos. A migração `20261008014022_optimize_invariant_snapshot_same_checks.sql` materializa métricas e grafos uma vez, reutiliza as chaves dos nós e detecta as mesmas 13 chaves de privacidade na representação JSONB canônica.
- Foram preservadas as 25 métricas, os totais, o proprietário, `SECURITY DEFINER`, o `search_path` vazio e a execução somente por `service_role`. Não houve aumento de timeout, alteração de Auth/RLS ou novo agendamento.
- Equivalência no PostgreSQL: 4.500 casos de existência de nós, 1.845 grafos com escopo de documentos e 165 casos de privacidade, sem divergências. Outros 149 casos de privacidade também passaram. Os arquivos `tests/sql/invariant-snapshot-equivalence.sql` e `tests/sql/invariant-snapshot-privacy-regression.sql` usam apenas valores sintéticos e são somente leitura.
- Após aplicar a migração no TESTE, o endpoint real `run-quality-audit` respondeu HTTP 200 / `PASS`: 25 métricas zero, nenhuma violação ou alerta. A execução registrada durou 445 ms em 7 de outubro de 2026, às 22:41 (São Paulo); esse tempo descreve o volume observado, não uma garantia para qualquer carga.
- Fontes distingue falha da consulta de uma violação medida: apresenta “Autoauditoria indisponível” sem contadores e sem expor o snapshot ou erro interno. Violações realmente medidas continuam visíveis. O histórico original da auditoria foi preservado.

Credenciais e checkpoints de QA ficam fora do repositório. Brave e Portal da Transparência seguem bloqueados por configuração, conforme decisão do usuário. JUCESP e DOU permanecem rotas documentais manuais. Nenhum deploy em produção ou alteração de `main` faz parte desta entrega.
