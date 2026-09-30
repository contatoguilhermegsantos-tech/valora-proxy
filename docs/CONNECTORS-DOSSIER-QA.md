# MAX — conectores e organização do dossiê

Data: 30/09/2026. Escopo: max-v1 e backend de teste dczropngwfoxybdmybgw.

- Busca web passa a ser executada no roteiro, sem promover snippets a fatos.
- Brave: timeout e retentativa limitados, domínios com correspondência exata, reconsulta preserva revisão, falha total não declara conexão bem-sucedida.
- Portal: exige vínculo suportado/verificado e permissão de pesquisa; preserva evidências e eventos revisados; páginas limitadas ou falhas parciais permanecem PARTIAL.
- Dossiê separa visão comercial, perfil documentado e validação. Mostra lacunas de cadastro, atividade e dados financeiros sem score de completude.
- Documentos que contradizem fatos não sustentam temas comerciais.

Validação: 31 testes automatizados passaram; build Next.js passou. Backend publicado em teste. Consulta real Brave/Portal permanece pendente das credenciais BRAVE_SEARCH_API_KEY e PORTAL_TRANSPARENCIA_API_TOKEN, configuradas como secrets no backend, nunca no frontend ou repositório.

Limites: a cobertura exibida por dimensão é inicial e parcial; ainda não inclui todo o passaporte empresarial proposto no MAX Market Scout. Histórico de alterações, liquidez consultiva e trajetórias de relacionamento continuam em backlog. PNCP e Querido Diário dependem também de disponibilidade externa; não há garantia de operação perfeita.

QA real: respostas 401 sem sessão, 404 entre organizações e 403 para VIEWER em ambos os conectores; 428 CONFIG_REQUIRED sem credenciais. Dossiê de empresa retorna 10 fatos verificados. Perfil documentado e visão comercial conferidos no navegador, sem erros de console. Deploy preview inicial READY (3d19bb5). Nenhuma mudança em main (259924c).
