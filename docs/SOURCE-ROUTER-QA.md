# MAX — investigação por pergunta

Escopo: max-v1 e backend de teste. Main e produção preservadas. Próxima etapa derivada do MAX Market Scout.

- Catálogo central de 12 capacidades: descoberta, cadastro/QSA, demonstrações, menções municipais, BNDES, contratos PNCP, registros federais, cadastro CVM, IPE, histórico societário, M&A e contexto web.
- O roteiro escolhe o conector habilitado por capacidade, registra a rota em cada etapa e mantém a atribuição do provedor efetivamente utilizado. Cadastro utiliza o fallback BrasilAPI → Base Empresarial já validado.
- Brave e Portal permanecem desativados sem credenciais, mesmo se o catálogo indicar CONNECTED. Juntas e CADE permanecem documentais/manuais, sem execução fictícia. JUCESP não representa cobertura nacional.
- Consultas empresariais independentes executam até duas por vez. IPE aguarda elegibilidade CVM. Falha de uma consulta não impede registrar resultados das demais; falha de gravação impede declarar progresso não persistido.
- Investigação mostra seis dimensões de resposta, registros e documentos de suporte, próximos passos e rotas. Consulta concluída não representa completude. CNAE/porte, QSA e metadados de demonstrações não comprovam escala, poderes financeiros ou situação financeira atual.
- Empresa rejeitada, candidato não resolvido, evidência rejeitada e apoio contraditório não preenchem as respostas. Empresas são identificadas nominalmente, preservando o núcleo de origem.
- Navegação do dossiê quebra em linhas para manter Validação e Histórico acessíveis.

Validação automatizada: 66 testes aprovados, incluindo execução do handler real de orquestração com transporte/banco controlados, limite de concorrência, espera pelo lote, permissões, rotas sem credenciais, elegibilidade CVM e isolamento de evidências. Build Next.js e tipos aprovados.

Limites: seleção por qualidade/custo histórico e roteamento adaptativo ainda não implementados. Nenhum novo fornecedor contratado. CADE/Juntas/DOU e indexação própria continuam pendentes. Validação ampliada de 30 empresas e seus sócios continua pendente. Não há promessa de redução percentual de tempo; depende das fontes externas.
