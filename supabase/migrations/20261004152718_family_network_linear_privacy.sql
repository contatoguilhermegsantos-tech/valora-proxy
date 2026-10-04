-- Test-only corrective migration. Preserve all keys, embedded-ID patterns,
-- grants, security mode and timeout. JSONB text is canonical: decoded Unicode
-- keys serialize normally, quotes/backslashes inside strings stay escaped.
-- A key must follow an object delimiter and end with an unescaped quote+colon.
create or replace function private.family_network_private_fields(value jsonb) returns boolean
language plpgsql immutable security invoker set search_path='' as $$
declare serialized text := coalesce(value::text,'');
begin
 return serialized ~* '(^|[,{])[[:space:]]*"(([^"\\]|\\.)*(cpf|age_group|faixa_etaria|birth|residen|personal_address|logradouro|bairro|telefone|email|representante)([^"\\]|\\.)*|(age|idade|address|cep|partner_identifier))"[[:space:]]*:'
 or serialized ~ '(\*{2,}[.[:space:]-]*[0-9][0-9.[:space:]-]{2,}[0-9][.[:space:]-]*\*{2,})|((^|[^A-Za-z0-9])[0-9]{3}[.[:space:]]?[0-9]{3}[.[:space:]]?[0-9]{3}[-[:space:]]?[0-9]{2}(?![A-Za-z0-9]))';
end $$;
revoke all on function private.family_network_private_fields(jsonb) from public,anon,authenticated;
grant execute on function private.family_network_private_fields(jsonb) to service_role;

