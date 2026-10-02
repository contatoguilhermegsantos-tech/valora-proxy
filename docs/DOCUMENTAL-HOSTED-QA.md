# MAX — QA documental financeiro no ambiente hospedado

Rodada iniciada em 1 de outubro de 2026. Validação real do Supabase de teste, com WEG e SLC em organização exclusiva de QA. Nenhuma produção, branch main ou lead do usuário foi alterado.

## Resultado

Os dois fluxos reais passaram. Cada empresa recebeu sete valores históricos do DFP oficial da CVM, com CNPJ emissor exato, conta, período, escala, versão e documento verificado. O passaporte apresentou os sete valores com suporte oficial; a investigação financeira permaneceu PARTIAL, pois a leitura anual consolidada não comprova posição atual, dívida completa ou inteligência financeira integral.

| Empresa | CNPJ emissor | Estratégia | Pesquisa completa | Consulta DFP direta | Valores do passaporte | Etapa DFP | Completude financeira |
|---|---|---|---:|---:|---:|---|---|
| WEG SA | 84429695000111 | Empresário | 44 s | 3 s | 7 | COMPLETED | PARTIAL |
| SLC AGRICOLA S.A. | 89096457000155 | Agro | 31 s | 2 s | 7 | COMPLETED | PARTIAL |

Os tempos medem esta rodada; disponibilidade e duração futuras podem variar. “Pesquisa completa” indica o processamento das etapas solicitadas, com status geral PARTIAL por limites e pendências de outras fontes; não significa cobertura comercial completa.

## Achado do vínculo e correção validada

As duas fixtures empresariais começaram com vínculo PENDING, embora tivessem initial_cnpj exato e cadastro documentado. Isso bloqueava fontes profundas com HTTP 409.

O fluxo normal corrigido validou automaticamente PENDING → SUPPORTED somente para núcleo COMPANY, CNPJ inicial coincidente e evidência cadastral VERIFIED no próprio núcleo e empresa. WEG e SLC passaram sem alteração manual dos vínculos para obter o resultado positivo. A identidade jurídica ficou suportada; nenhuma identidade pessoal foi confirmada.

Pessoas e vínculos rejeitados seguem sujeitos à revisão. A regra não autoriza atribuir uma empresa a uma pessoa apenas por nome, escolher um CNPJ empresarial como identificador pessoal ou reabrir uma rejeição. O caso REJECTED foi verificado remotamente: o conector DFP respondeu 409, o orquestrador finalizou PARTIAL com etapas cadastral/financeira BLOCKED e o vínculo permaneceu REJECTED. A própria fixture de QA foi restaurada depois do teste.

## Valores comprovados no recorte

Fonte primária: [DFP anual oficial da CVM de 2025](https://dados.cvm.gov.br/dados/CIA_ABERTA/DOC/DFP/DADOS/dfp_cia_aberta_2025.zip), membros consolidados BPA, BPP e DRE. As 14 contas extraídas nesta validação pertencem ao exercício/posição de 31/12/2025 e versão 1. Valores originais em escala MIL foram convertidos para BRL, com a escala original preservada.

| Conta documentada | WEG — consolidado | SLC Agrícola — consolidado |
|---|---:|---:|
| Receita de vendas | R$ 40.804.110.000,00 | R$ 9.759.214.000,00 |
| Resultado líquido consolidado | R$ 6.775.958.000,00 | R$ 565.213.000,00 |
| Caixa e equivalentes | R$ 6.296.498.000,00 | R$ 2.647.586.000,00 |
| Ativo total | R$ 42.645.030.000,00 | R$ 21.341.432.000,00 |
| Ativo circulante | R$ 26.910.845.000,00 | R$ 9.845.683.000,00 |
| Passivo circulante | R$ 17.386.401.000,00 | R$ 5.465.900.000,00 |
| Patrimônio líquido consolidado | R$ 18.553.364.000,00 | R$ 5.655.435.000,00 |

Receita e resultado se referem ao período anual declarado na fonte; ativo, passivo, patrimônio líquido e caixa se referem à posição contábil datada. Consolidado inclui o emissor e suas controladas; esses valores não são patrimônio pessoal, liquidez atual de um sócio, valor disponível para investir ou orçamento comercial inferido. Dívida completa não foi estimada a partir do passivo circulante.

## Persistência, passaporte e histórico

- Sete fatos por empresa classificados FACT/VERIFIED, todos com suporte PRIMARY_OFFICIAL/VERIFIED e documento CVM_DFP_FINANCIAL_STATEMENTS da própria empresa.
- Todos os documentos financeiros preservam CNPJ, período, unidade BRL, escala original, versão, conta oficial e URL do arquivo CVM.
- As reconsultas diretas responderam 200/complete=true e reaproveitaram os mesmos IDs de fatos e documentos, sem duplicatas.
- O passaporte apresentou sete valores documentados por empresa; a dimensão financeira de investigação permaneceu PARTIAL.
- As pesquisas EMPRESARIO e AGRO gravaram histórico automaticamente. Os dois snapshots originais positivos contêm os sete fatos financeiros com empresa, fonte cvm_dfp, período e escopo consolidados na chave semântica.
- A etapa financial_statements concluiu com source_key=cvm_dfp e metadata year=2025, scope=CONSOLIDATED, complete=true, facts_found=7 e review_required=0.

## Controles remotos verificados

| Caso | Resultado observado |
|---|---|
| Sem JWT | 401 |
| Usuário QA temporariamente VIEWER | 403; papel OWNER restaurado após o teste |
| Empresa inexistente | 404 |
| Empresa de outra organização de QA | 404 |
| Empresa existente sem vínculo com o núcleo solicitado | 409 |
| Vínculos inicialmente PENDING, antes da validação no fluxo normal | 409 no conector direto |
| Vínculo QA temporariamente REJECTED | 409 no DFP; pesquisa PARTIAL com fontes BLOCKED e rejeição preservada |

Os testes negativos usam somente fixtures técnicas de QA. A observação inicial de um assert incorreto do runner — esperar 409 também do orquestrador — foi corrigida: o contrato do orquestrador é terminar PARTIAL e bloquear as fontes enquanto mantém a rejeição. Nenhuma falha do produto foi inferida daquele assert.

## Alcance e limites

Este QA comprova a extração e persistência de sete contas selecionadas para dois emissores abertos, a apresentação no passaporte, a preservação de revisão e o histórico. Não cobre todas as empresas do corpus de 30, todos os exercícios, demonstrações individuais, balanços privados, IFRS personalizados, dívida detalhada ou outros documentos financeiros.

As duas pesquisas positivas usaram o fluxo start-research corrigido para validação de vínculo. A revisão final v35 do orquestrador trata persistência de identidade; não alterou as contas, a fonte DFP ou seu status. Os controles e a reconsulta descritos são resultados do ambiente hospedado, além dos testes locais reportados pelo responsável pelo desenvolvimento.

Brave e Portal da Transparência permanecem desativados por orientação do usuário. A cobertura geral continua parcial pelas fontes ainda limitadas, indisponíveis ou não integradas.

Sessões, tokens, IDs de organização, IDs internos de leads e respostas privadas permaneceram fora deste relatório e do repositório público. Publicação na max-v1 fica a cargo do agente responsável pelo desenvolvimento.
