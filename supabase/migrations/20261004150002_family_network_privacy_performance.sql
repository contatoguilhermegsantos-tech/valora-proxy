-- Keep the privacy contract, privilege model and timeouts unchanged.
-- jsonb_path_exists stops without materializing every key/value pair;
-- strict traversal avoids duplicate lax array unwrapping. Regex existence
-- tests use the exact two patterns already used by scrub_text.
create or replace function private.family_network_private_fields(value jsonb) returns boolean
language sql immutable security invoker set search_path='' as $$
 select jsonb_path_exists(coalesce(value,'{}'::jsonb),
  'strict $.** ? (@.type() == "object").keyvalue() ? (@.key like_regex "(cpf|age_group|faixa_etaria|birth|residen|personal_address|logradouro|bairro|telefone|email|representante)" flag "i" || @.key like_regex "^(age|idade|address|cep|partner_identifier)$" flag "i")')
 or coalesce(value::text,'') ~ '(\*{2,}[.[:space:]-]*[0-9][0-9.[:space:]-]{2,}[0-9][.[:space:]-]*\*{2,})|((^|[^A-Za-z0-9])[0-9]{3}[.[:space:]]?[0-9]{3}[.[:space:]]?[0-9]{3}[-[:space:]]?[0-9]{2}(?![A-Za-z0-9]))';
$$;
revoke all on function private.family_network_private_fields(jsonb) from public,anon,authenticated;
grant execute on function private.family_network_private_fields(jsonb) to service_role;
