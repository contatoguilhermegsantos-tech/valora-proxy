# P0 — identidade e confiabilidade

Escopo: branch `max-v1`, preview Vercel e projeto Supabase MAX. A `main` permanece no Valora; nenhuma promoção para produção faz parte deste bloco.

## Entregue

- Motor `identity-v1.2`: recalcula nome/cidade/UF com o contexto atual, inclui o grupo líder no bloqueio de ambiguidade e preserva confirmação/rejeição concorrente do usuário.
- SUPPORTED não significa VERIFIED. Vínculos ambíguos não entram no enriquecimento automático de clusters.
- Fallback registra ausência de resultado, falta de cobertura, rota manual, configuração pendente e falha. Chamadas do motor têm timeout; ausência de resultado não vira prova negativa.
- Operações de identidade, confirmação, descoberta e enriquecimento recusam VIEWER antes de qualquer escrita.
- Confirmação usa VERIFIED no vínculo empresarial, conforme o contrato do banco. Rejeição explícita retira a atribuição lead–empresa, preservando documentos e outras confirmações.
- Autoauditoria usa a avaliação mais recente por candidato, verifica a organização das evidências de suporte e detecta identificadores mascarados com expressão regular corrigida.
- Fontes mostra 19 fontes cadastradas, seis candidatas ordenadas por prioridade, dependências, limitações e última autoauditoria. O endpoint retorna somente metadados operacionais a membros ativos.
- Código de funções publicadas foi recuperado para o repositório; o orquestrador antigo no GitHub não deve ser reimplantado.
- Dependências fixadas e lockfile incluído para builds reproduzíveis.

## Validações executadas

| Cenário | Resultado |
|---|---|
| Build Next.js e TypeScript | PASS |
| `node --test tests/identity.test.mjs` | 9/9 |
| Novo lead PF pelo navegador → fila → dossiê | PASS |
| Ronaldo Gonçalves Lino, Barretos/SP | 5 candidatos; 3 SUPPORTED, 2 REVIEW; sem VERIFIED automático |
| Cadastro/QSA, fatos, evidências e empresas | Persistidos e exibidos |
| Confirmação explícita via API | Lead e vínculo empresarial VERIFIED |
| Reavaliação de identidade confirmada | VERIFIED preservado |
| Rejeição explícita | Vínculo REJECTED; documentos preservados |
| Downgrade de VERIFIED mantendo confirmação | Bloqueado pelo trigger; teste transacional revertido |
| VIEWER em oito endpoints de escrita | 403 em todos; leitura do dossiê continua 200 |
| Workspace B lendo lead de A | Endpoint 404; RLS retorna lista vazia |
| Fallback sem candidatos | NO_MATCH → NOT_COVERED → MANUAL_REQUIRED → CONFIG_REQUIRED |
| Snapshot de invariantes após QA | 0 críticos, 0 alertas |

Os testes criaram workspaces separados identificados como QA. Uma confirmação dentro desses cenários valida o software, não constitui afirmação comercial sobre uma pessoa real.

## Dependências externas ainda explícitas

Brave e Portal da Transparência dependem de credenciais legítimas. DOU e JUCESP têm rotas manuais; CADE e índice próprio RFB continuam no backlog. Nenhuma dessas dependências foi apresentada como integração concluída.

O repositório ainda não contém todo o histórico de fundação do banco nem todos os conectores antigos. As funções recuperadas e a migração deste bloco são compatíveis com o MAX existente; não constituem um instalador de banco vazio. A autenticação anônima atual continua sendo configuração de piloto.

O advisor do Supabase ainda reporta avisos preexistentes: funções de normalização com search_path mutável, trigger de normalização com EXECUTE público, pg_net no schema public e proteção de senhas vazadas desativada. RLS sem políticas nas tabelas internas é intencional (acesso somente por serviço). Zero invariantes violadas não significa que todos os avisos de preparação para produção estejam encerrados. Referências: [funções](https://supabase.com/docs/guides/database/database-linter?lint=0011_function_search_path_mutable), [permissões](https://supabase.com/docs/guides/database/database-linter?lint=0028_anon_security_definer_function_executable), [extensões](https://supabase.com/docs/guides/database/database-linter?lint=0014_extension_in_public), [senhas](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection).

