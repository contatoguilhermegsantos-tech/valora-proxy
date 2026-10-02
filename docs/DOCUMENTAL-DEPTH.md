# Profundidade documental: CVM DFP

O conector `cvm-financial-statements` acrescenta valores explicitamente publicados no DFP oficial ao passaporte da companhia. Consulta o CNPJ completo do emissor, sem expandir automaticamente a marca ou o grupo. A cobertura é de companhias que entregaram DFP; empresas privadas permanecem dependentes de outras publicações ou documentos obtidos com a empresa.

## Escopo

- Padrão: último ano civil encerrado (2025 na validação de 01/10/2026). A consulta não representa o exercício de 2026 nem posição financeira atual.
- Demonstrações consolidadas BPA, BPP e DRE; a posição abrange o emissor e suas controladas. Não é demonstração individual do CNPJ nem patrimônio pessoal dos sócios.
- Contas fixas selecionadas: receita de vendas, lucro/prejuízo consolidado do período, caixa e equivalentes, ativo total, ativo circulante, passivo circulante e patrimônio líquido consolidado.
- A descrição oficial da conta acompanha o valor. Formatos específicos de bancos e outras entidades não são convertidos em receita industrial por aproximação.
- `MIL` é multiplicado por 1.000 com transformação decimal exata; `UNIDADE` é conservada. Valores com mais de duas casas decimais também registram o decimal BRL exato no texto persistido, para que o arredondamento visual a centavos não una fatos diferentes. Moeda, escala ou descrição desconhecidas não produzem um número presumido.
- Período, código da conta, escala original, versão e origem ficam em `claims.value_json.financial_document`. O texto visível também contém período, escopo e versão.
- Escolhe a maior versão do DFP por data de referência. Compara a versão de todas as linhas elegíveis de cada demonstrativo, inclusive contas fora das sete métricas selecionadas; não combina versões diferentes dos três demonstrativos para um mesmo período. A reapresentação que conflitar com um fato já verificado permanece sujeita à revisão existente do MAX; não substitui automaticamente o histórico.

## Leitura segura e verificável

A fonte oferece ZIPs anuais do mercado inteiro. O conector lê o diretório no final do ZIP e solicita apenas os três membros necessários por HTTP Range. Exige HTTP 206, `Content-Range` coerente, ETag forte estável, nomes locais consistentes e CRC32 correto. Processa CSV durante a descompressão, sem manter todos os demonstrativos em memória. Limites: 2 MB comprimidos e 32 MB descomprimidos por membro, até 5.000 linhas do CNPJ, 16 KB por registro e prazo de 60 segundos para a leitura externa. Um arquivo maior ou uma resposta incompatível resulta em falha de consulta explícita; não prova ausência de finanças.

O endpoint valida a sessão pelo Supabase Auth, o papel de escrita na organização ativa, a propriedade de lead/empresa e o vínculo `SUPPORTED` ou `VERIFIED`. Um `research_run_id` informado também precisa pertencer ao mesmo lead e organização. Preserva evidências e fatos rejeitados/contraditados. Falhas de evidência, suporte, verificação ou gravação do resultado impedem resposta de sucesso. O estado do fato é relido após os gatilhos de contradição.

## Integração

1. Cadastrar `cvm_dfp` como fonte oficial com cobertura limitada.
2. Executar a etapa `financial_statements` após validar a aplicabilidade CVM; uma companhia ausente no cadastro consultado não deve disparar a leitura anual sem contexto.
3. Corpo: `{lead_id, company_id, research_run_id?, year?}`.
4. Sucesso: `facts_found` conta apenas fatos persistidos que continuam `VERIFIED`; `extracted_count` conta linhas selecionadas. `review_required > 0` implica `complete:false`.
5. Zero fatos significa nenhuma conta selecionada no recorte e esquema suportados, sem concluir que a companhia não publicou demonstrações ou que não tem receita/caixa.
6. Expor os números no passaporte financeiro com o período e a expressão “consolidado”; conservar lacunas de dívida, posição atual e decisão financeira.

## Validação realizada antes do deploy

13 testes automatizados passaram: seleção de CNPJ/ano/escopo/versão, comparação de versões sem métricas selecionadas, escala e identidade decimal exatas, conflito na mesma conta, leitura ZIP por ranges, ausência de Range, ETag divergente, CRC adulterado, tamanho excessivo, preservação de rejeição, falha de suporte, releitura após contradição e autorização antes da consulta/gravação.

O leitor foi executado contra o ZIP oficial de 2025 para WEG (`84429695000111`) e SLC Agrícola (`89096457000155`). Ambos retornaram sete contas, com data de referência 31/12/2025 e versão 1. A leitura local levou aproximadamente 2,0 s e 1,0 s, respectivamente; CPU medida abaixo de 1,1 s por consulta. São medições do leitor local, não promessa de latência do fluxo completo nem confirmação de execução no runtime hospedado. A validação do endpoint hospedado e do passaporte é registrada pelo QA da etapa de integração.

Exemplos de transformação conferidos no dado bruto:

| Companhia | Conta | Valor original / escala | Valor convertido | Período |
| --- | --- | --- | --- | --- |
| WEG | Receita de venda de bens e/ou serviços | 40.804.110 / MIL | R$ 40.804.110.000 | 01/01 a 31/12/2025 |
| SLC Agrícola | Lucro/prejuízo consolidado do período | 565.213 / MIL | R$ 565.213.000 | 01/01 a 31/12/2025 |

## Fontes primárias

- [Conjunto DFP e política de reapresentação semanal — CVM](https://dados.cvm.gov.br/dataset/cia_aberta-doc-dfp).
- [Repositório oficial de ZIPs anuais — CVM](https://dados.cvm.gov.br/dados/CIA_ABERTA/DOC/DFP/DADOS/).
- [ZIP oficial consultado de 2025](https://dados.cvm.gov.br/dados/CIA_ABERTA/DOC/DFP/DADOS/dfp_cia_aberta_2025.zip).
- [Dicionário de dados oficial DFP](https://dados.cvm.gov.br/dados/CIA_ABERTA/DOC/DFP/META/meta_dfp_cia_aberta_txt.zip).
- [Descompressão por streams — Deno](https://docs.deno.com/examples/compress_decompress/).
- [Limites de runtime — Supabase](https://supabase.com/docs/guides/functions/limits).

Attribution: Comissão de Valores Mobiliários — CVM, Portal Dados Abertos, DFP. O conjunto informa licença ODbL. Não são incluídos arquivos de sessão, segredos ou o ZIP integral no repositório do MAX.
