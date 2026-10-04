# Pesquisa de leads

O fluxo de investigação começa em **Criar e investigar**, na lista de leads, ou em **Nova pesquisa**, no dossiê. A segunda ação inicia a fila usando o contexto atual do lead. **Configurar pesquisa** permite revisar a estratégia e o CNPJ antes de iniciar.

A criação do lead e o início da pesquisa são operações separadas. Se o lead for salvo e a fila não aceitar a execução, o dossiê mostra o erro e permite iniciar novamente para o mesmo lead. Não se deve criar outro lead para tentar novamente.

## Acompanhamento

O modo pesquisa acompanha o identificador da execução na fila. As etapas vêm do plano persistido da pesquisa vinculada àquela execução; pesquisas anteriores não são usadas para representar uma pesquisa nova.

- Antes da criação do plano, a tela informa que a execução aguarda processamento.
- Durante a execução, mostra etapas aguardando, em andamento, concluídas, limitadas, bloqueadas ou com falha.
- Etapas bloqueadas ou puladas podem estar finalizadas sem produzir evidência. Avanço do plano não mede completude da inteligência.
- Uma tentativa agendada mantém o estado de espera; falha definitiva oferece nova tentativa explícita.
- Ao concluir e receber o dossiê atualizado da execução, a tela abre os resultados automaticamente, mantendo as limitações de cobertura visíveis.

O identificador da execução é mantido na navegação para retomar o acompanhamento depois de uma recarga. A leitura do progresso não cria outra investigação. Uma investigação ativa é reutilizada pelo servidor para evitar duplicação.

## Empresa criada sem CNPJ

Uma empresa pode começar pelo nome. Nessa situação, o MAX consulta separadamente os campos de razão social e nome fantasia da Base Empresarial. A [API do provedor](https://app.baseempresarial.com.br/api/docs) usa correspondência por prefixo: não equivale a pesquisa aproximada por qualquer palavra de uma marca. As consultas têm limites de páginas, quantidade de resultados e duração; cobertura truncada ou falha externa permanece explícita.

Os resultados são candidatos `RFB_COMPANY_NAME_MATCH`, vinculados ao CNPJ completo e aos documentos consultados. Nenhuma empresa é atribuída automaticamente ao lead apenas pelo nome. Cidade e UF ajudam a comparar candidatos; a confirmação é uma ação humana sobre o vínculo escolhido. Um candidato descartado permanece descartado após uma nova consulta.

A busca por nome empresarial não usa o nome da empresa como nome de sócio, não confirma parentesco e não mistura a marca com todas as entidades jurídicas de um grupo. Fontes que exigem CNPJ continuam bloqueadas até haver uma entidade jurídica resolvida.

## Escopo de publicação

Este fluxo é validado no projeto Supabase de teste e no preview da branch `max-v1`. `main` e o deployment de produção são preservados. Brave e Portal da Transparência permanecem desativados enquanto seus acessos não estiverem configurados.
