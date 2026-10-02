# MAX — corpus de 30 empresas e QA nominal

Rodada de QA: 1 de outubro de 2026. Ambiente exclusivo de teste e organização de QA. Nenhum dado de produção ou lead do usuário foi alterado.

## Resultado e alcance

- 30 empresas distintas tentadas; 30 aprovadas em cadastro, estabelecimento exato, evidência e persistência do QSA.
- 327 fatos cadastrais verificados e 296 registros de pessoas no QSA, com documento de suporte. QSA pode descrever administradores, diretores, presidentes ou conselheiros; não equivale a prova de beneficiário final ou patrimônio.
- 10 unidades da Federação: RJ, SC, RS, SP, BA, MG, DF, CE, MA, PR.
- BrasilAPI respondeu nas 30 consultas desta rodada. Nas medições mais recentes de cada CNPJ, enriquecimento: mediana 3 s, intervalo 2–5 s. Essa medição não comprova disponibilidade futura do provedor.
- 30 leads pessoais isolados, um nome cadastral por empresa, permaneceram PENDING no teste sem descoberta; nenhum CNPJ empresarial foi atribuído à pessoa. Estes testes medem preservação de estado, não descoberta ou resolução de identidade.
- 6/6 cenários adicionais executaram descoberta nominal real e resolução contextual, sem confirmação pessoal automática.
- Hospital Village, CNPJ 32901144000105, é um caso privado adicional ao corpus: cadastro aprovado, provedor base_empresarial_rfb, 9 registros QSA. Não é contado entre as 30 companhias da CVM.

A nova leitura do backend confirmou que conselheiros não são apresentados como sócios apenas pelo cargo. As 84 classificações de papel identificadas na primeira execução foram corrigidas e revalidadas.

## Origem pública e critérios

Os 30 CNPJs foram selecionados no [cadastro oficial de companhias abertas da CVM](https://dados.cvm.gov.br/dados/CIA_ABERTA/CAD/DADOS/cad_cia_aberta.csv). Arquivo local consultado em 01/10/2026, 22:39:54 (horário de São Paulo); SHA-256: ec9b1073947a64a26c2232558cab21556ec3074d4d6061fe6196105f93f00b62.

Para cada empresa, a resposta cadastral precisava corresponder ao estabelecimento completo de 14 posições, conter razão social, município/UF e evidência verificada. Cada fato e relação cadastral foi conferido contra o documento de suporte. Pessoas de nomes iguais em contextos empresariais diferentes permaneceram em nós distintos e UNRESOLVED. Valores pessoais, CPFs ou patrimônios não foram inventados.

As cidades dos cenários pessoais servem apenas como contexto de busca. Município da matriz não comprova domicílio da pessoa. Diferenças de apresentação de nomes entre CVM e cadastro RFB foram registradas sem forçar identidade textual entre os dois documentos.

| Empresa no cadastro consultado | CNPJ completo | Local da empresa | Fatos | Registros QSA | Cadastro/evidência | Semântica do papel QSA |
|---|---|---|---:|---:|---|---|
| PETROLEO BRASILEIRO S A PETROBRAS | [33000167000101](https://brasilapi.com.br/api/cnpj/v1/33000167000101) | RIO DE JANEIRO/RJ | 11 | 8 | Aprovado | Aprovado |
| VALE S.A. | [33592510000154](https://brasilapi.com.br/api/cnpj/v1/33592510000154) | RIO DE JANEIRO/RJ | 11 | 6 | Aprovado | Aprovado |
| WEG SA | [84429695000111](https://brasilapi.com.br/api/cnpj/v1/84429695000111) | JARAGUA DO SUL/SC | 11 | 12 | Aprovado | Aprovado |
| SLC AGRICOLA S.A. | [89096457000155](https://brasilapi.com.br/api/cnpj/v1/89096457000155) | PORTO ALEGRE/RS | 11 | 10 | Aprovado | Aprovado |
| JBS S/A | [02916265000160](https://brasilapi.com.br/api/cnpj/v1/02916265000160) | SAO PAULO/SP | 11 | 4 | Aprovado | Aprovado |
| MARFRIG GLOBAL FOODS S.A. | [03853896000140](https://brasilapi.com.br/api/cnpj/v1/03853896000140) | SAO PAULO/SP | 11 | 4 | Aprovado | Aprovado |
| MINERVA S.A. | [67620377000114](https://brasilapi.com.br/api/cnpj/v1/67620377000114) | BARRETOS/SP | 11 | 5 | Aprovado | Aprovado |
| RAIZEN S.A. | [33453598000123](https://brasilapi.com.br/api/cnpj/v1/33453598000123) | RIO DE JANEIRO/RJ | 11 | 6 | Aprovado | Aprovado |
| COSAN S.A. | [50746577000115](https://brasilapi.com.br/api/cnpj/v1/50746577000115) | SAO PAULO/SP | 11 | 3 | Aprovado | Aprovado |
| SUZANO S.A. | [16404287000155](https://brasilapi.com.br/api/cnpj/v1/16404287000155) | SALVADOR/BA | 11 | 6 | Aprovado | Aprovado |
| KLABIN S.A. | [89637490000145](https://brasilapi.com.br/api/cnpj/v1/89637490000145) | SAO PAULO/SP | 11 | 24 | Aprovado | Aprovado |
| EMBRAER S.A. | [07689002000189](https://brasilapi.com.br/api/cnpj/v1/07689002000189) | SAO JOSE DOS CAMPOS/SP | 11 | 12 | Aprovado | Aprovado |
| TOTVS S.A. | [53113791000122](https://brasilapi.com.br/api/cnpj/v1/53113791000122) | SAO PAULO/SP | 11 | 8 | Aprovado | Aprovado |
| LWSA S/A | [02351877000152](https://brasilapi.com.br/api/cnpj/v1/02351877000152) | SAO PAULO/SP | 11 | 11 | Aprovado | Aprovado |
| MAGAZINE LUIZA S/A | [47960950000121](https://brasilapi.com.br/api/cnpj/v1/47960950000121) | FRANCA/SP | 11 | 5 | Aprovado | Aprovado |
| LOJAS RENNER S.A. | [92754738000162](https://brasilapi.com.br/api/cnpj/v1/92754738000162) | PORTO ALEGRE/RS | 11 | 13 | Aprovado | Aprovado |
| LOCALIZA RENT A CAR SA | [16670085000155](https://brasilapi.com.br/api/cnpj/v1/16670085000155) | BELO HORIZONTE/MG | 11 | 6 | Aprovado | Aprovado |
| RANDONCORP S.A. | [89086144000116](https://brasilapi.com.br/api/cnpj/v1/89086144000116) | CAXIAS DO SUL/RS | 11 | 8 | Aprovado | Aprovado |
| MARCOPOLO SA | [88611835000129](https://brasilapi.com.br/api/cnpj/v1/88611835000129) | CAXIAS DO SUL/RS | 11 | 9 | Aprovado | Aprovado |
| RUMO S.A | [02387241000160](https://brasilapi.com.br/api/cnpj/v1/02387241000160) | SAO PAULO/SP | 11 | 4 | Aprovado | Aprovado |
| B3 S.A. - BRASIL, BOLSA, BALCAO | [09346601000125](https://brasilapi.com.br/api/cnpj/v1/09346601000125) | SAO PAULO/SP | 11 | 8 | Aprovado | Aprovado |
| BANCO DO BRASIL SA | [00000000000191](https://brasilapi.com.br/api/cnpj/v1/00000000000191) | BRASILIA/DF | 11 | 41 | Aprovado | Aprovado |
| EMPREENDIMENTOS PAGUE MENOS S/A | [06626253000151](https://brasilapi.com.br/api/cnpj/v1/06626253000151) | FORTALEZA/CE | 11 | 8 | Aprovado | Aprovado |
| ENGIE BRASIL ENERGIA S.A. | [02474103000119](https://brasilapi.com.br/api/cnpj/v1/02474103000119) | FLORIANOPOLIS/SC | 11 | 9 | Aprovado | Aprovado |
| ENERGISA S/A | [00864214000106](https://brasilapi.com.br/api/cnpj/v1/00864214000106) | CATAGUASES/MG | 11 | 5 | Aprovado | Aprovado |
| EQUATORIAL S.A. | [03220438000173](https://brasilapi.com.br/api/cnpj/v1/03220438000173) | SAO LUIS/MA | 10 | 17 | Aprovado | Aprovado |
| COMPANHIA DE SANEAMENTO DO PARANA SANEPAR | [76484013000145](https://brasilapi.com.br/api/cnpj/v1/76484013000145) | CURITIBA/PR | 10 | 16 | Aprovado | Aprovado |
| COMPANHIA DE SANEAMENTO DE MINAS GERAIS COPASA MG | [17281106000103](https://brasilapi.com.br/api/cnpj/v1/17281106000103) | BELO HORIZONTE/MG | 11 | 5 | Aprovado | Aprovado |
| COMPANHIA PARANAENSE DE ENERGIA - COPEL | [76483817000120](https://brasilapi.com.br/api/cnpj/v1/76483817000120) | CURITIBA/PR | 10 | 18 | Aprovado | Aprovado |
| TRANSMISSORA ALIANCA DE ENERGIA ELETRICA S/A | [07859971000130](https://brasilapi.com.br/api/cnpj/v1/07859971000130) | RIO DE JANEIRO/RJ | 11 | 5 | Aprovado | Aprovado |

O CNPJ em cada linha abre o documento cadastral consultado. Na resposta do MAX, o provedor e a URL reais foram preservados. O caso Hospital empregou fallback Base Empresarial nesta rodada.

## Descoberta por nome, ambiguidade e revisão

Os casos DAN IOSCHPE (Embraer/SP e Marcopolo/RS) e DENNIS HERSZKOWICZ (TOTVS/SP e Equatorial/MA) usam nomes realmente presentes em dois contextos do corpus. Isso demonstra risco de coincidência nominal; não afirma que sejam pessoas diferentes. Nós separados foram comprovados antes da busca.

“JOSE DA SILVA” é uma consulta de nome comum em um lead hipotético de QA, sem uma identidade real atribuída. ADRIANO ALVES PIMENTA foi consultado com referência ao caso cadastral privado de Barretos.

| Cenário de QA | HTTP da descoberta | Cobertura declarada | Candidatos avaliados | Estado pessoal | Ambiguidade | Tempo da descoberta |
|---|---:|---|---:|---|---|---:|
| dan embraer | 200 | PARTIAL | 15 | SUPPORTED | Não | 27 s |
| dan marcopolo | 200 | PARTIAL | 15 | SUPPORTED | Não | 26 s |
| dennis totvs | 200 | PARTIAL | 15 | CAUTION | Sim | 45 s |
| dennis equatorial | 200 | PARTIAL | 15 | SUPPORTED | Não | 46 s |
| private hospital | 200 | COMPLETED | 7 | SUPPORTED | Não | 7 s |
| common name | 200 | PARTIAL | 15 | CAUTION | Sim | 20 s |

Todos os cenários bem sucedidos conservaram identity_confirmed_by_user=false e initial_cnpj=null. SUPPORTED indica suporte contextual; CAUTION indica necessidade de desambiguação. Nenhum deles comprova identidade pessoal.

Reconsulta após rejeição explícita de candidato e invalidação humana de documento: aprovada; ambas as decisões permaneceram preservadas.

## Limites da validação

Este corpus concentra companhias abertas de grande porte; não representa 30 pequenas empresas privadas, microempresas, todas as cidades, estabelecimentos secundários ou empresas baixadas. Não foi executada uma investigação comercial completa de todas as fontes para cada uma das 30 empresas. O resultado aprova cadastro/QSA e os cenários nominais descritos, com os defeitos de semântica explicitados acima; não declara completude geral do P0.

As buscas nominais desta rodada podem ser parciais por paginação, teto de 15 registros ou falha na consulta de empresas candidatas. Ausência de candidato não demonstra inexistência de vínculo. Busca por apelido, abreviação, sobrenome isolado e agrupamento econômico amplo ainda precisam de validação própria. Brave e Portal continuam desativados por orientação do usuário; este QA não depende deles.

## Reprodutibilidade e privacidade

O executor manteve no máximo duas solicitações de QA em paralelo e checkpoints por CNPJ/cenário, para retomar sem criar leads duplicados. Scripts privados, sessões, tokens, identificadores da organização e respostas com IDs internos permanecem fora do repositório público. Este relatório inclui somente CNPJs, nomes cadastrais públicos e resultados agregados verificáveis.
