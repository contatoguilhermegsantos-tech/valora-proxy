insert into public.source_registry(key,name,category,source_tier,domain,connection_status,method,supports,limitations,action_url,coverage_notes)
values ('minha_receita_rfb','Minha Receita — cadastro CNPJ/RFB','Cadastro empresarial e pistas contextuais','AGGREGATOR','minhareceita.org','CONNECTED_LIMITED',
  'API pública sem credenciais; listagem municipal com cursor opaco, CNAE principal e QSA',
  '["family_context","company_registry_candidates"]'::jsonb,
  'Busca paginada experimental, sem garantia de disponibilidade. Cadastro derivado da RFB; não é confirmação independente da Base Empresarial ou BrasilAPI. Cidade é do estabelecimento. Sobrenome e QSA geram pistas, sem comprovar parentesco, identidade do lead, residência ou patrimônio pessoal.',
  'https://docs.minhareceita.org/como-usar/',
  'Sob demanda para pivô por sobrenome, município/UF e atividade. Até três páginas de 100 registros por rodada; continuação pelo cursor devolvido pela fonte. Sem armazenamento de CPF, idade ou endereço de sócio.')
on conflict(key) do nothing;
