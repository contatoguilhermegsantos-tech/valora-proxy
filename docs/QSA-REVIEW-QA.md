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

- 341 testes automatizados aprovados; build Next.js e verificação de tipos aprovados.
- 94 controles independentes executados no banco de teste em transação com rollback: escopo, documentos atuais/legados, acesso, decisões concorrentes simuladas por snapshots obsoletos, idempotência, multiempresa, duplicatas e preservação de vínculos manuais. Nenhuma fixture transitória permaneceu.
- Concorrência real entre requisições não é afirmada por esses controles de snapshots obsoletos.
- Os testes de contrato não garantem disponibilidade externa nem cobertura completa de uma fonte.

Credenciais e checkpoints de QA ficam fora do repositório. Brave e Portal da Transparência seguem bloqueados por configuração, conforme decisão do usuário. JUCESP e DOU permanecem rotas documentais manuais. Nenhum deploy em produção ou alteração de `main` faz parte desta entrega.
