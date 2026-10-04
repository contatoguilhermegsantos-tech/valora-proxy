-- Synthetic read-only SQL regression test; no credentials or hosted fixture IDs.
-- Run on the MAX test database after the canonical privacy migration.
begin;
do $qa$
declare failures text;
begin
 with cases(label,payload,expected) as (values
 ('null',null::jsonb,false), ('empty','{}'::jsonb,false),
 ('nested','{"safe":[{"deep":{"CPF":null}}]}'::jsonb,true),
 ('substring','{"owner_cpf_hint":null}'::jsonb,true),('exact_age','{"AGE":44}'::jsonb,true),
 ('safe_age_suffix','{"staged":44}'::jsonb,false),('escaped_quote_private_key','{"safe\"cpf":null}'::jsonb,true),
 ('escaped_backslash_private_key','{"safe\\cpf":null}'::jsonb,true),('escaped_ascii_private_key','{"\u0063pf":null}'::jsonb,true),
 ('literal_unicode_spelling','{"\\u0063pf":null}'::jsonb,false),
 ('key_looking_value','{"label":"{\"CPF\":null,\"address\":null}"}'::jsonb,false),
 ('key_looking_array_string','["text ,\"cpf\":null"]'::jsonb,false),
 ('value_only','{"surname":"CPF NAME"}'::jsonb,false),
 ('formatted_id','{"label":"QA 123.456.789-01 NAME"}'::jsonb,true),
 ('plain_id','{"label":"QA 12345678901 NAME"}'::jsonb,true),
 ('masked_id','{"label":"QA ***123456** NAME"}'::jsonb,true),
 ('cnpj','{"full_cnpj":"12345678000195"}'::jsonb,false),
 ('uuid','{"id":"12345678-1234-1234-1234-123456789012"}'::jsonb,false),
 ('nested_birth','[{"details":[{"birth_date":"removed"}]}]'::jsonb,true),
 ('safe_arrays','["ordinary",["text",3,true]]'::jsonb,false)
), compared as (
  select label, expected, private.family_network_private_fields(payload) as actual,
   exists(select 1 from jsonb_path_query(coalesce(payload,'{}'::jsonb),'$.** ? (@.type() == "object").keyvalue()') v
    where lower(v->>'key') ~ '(cpf|age_group|faixa_etaria|birth|residen|personal_address|logradouro|bairro|telefone|email|representante)'
     or lower(v->>'key') in ('age','idade','address','cep','partner_identifier'))
   or private.family_network_scrub_text(coalesce(payload::text,''))<>coalesce(payload::text,'') as original_result
  from cases
 ) select string_agg(label,', ' order by label) into failures from compared
  where actual is distinct from expected or actual is distinct from original_result;
 if failures is not null then raise exception 'Privacy contract regression: %', failures; end if;
end $qa$;
rollback;

