create or replace function private.family_network_scrub_text(value text) returns text
language sql immutable strict security invoker set search_path='' as $$
 select regexp_replace(
  regexp_replace(value,'\*{2,}[.[:space:]-]*[0-9][0-9.[:space:]-]{2,}[0-9][.[:space:]-]*\*{2,}','[identificador removido]','g'),
  '(^|[^A-Za-z0-9])[0-9]{3}[.[:space:]]?[0-9]{3}[.[:space:]]?[0-9]{3}[-[:space:]]?[0-9]{2}(?![A-Za-z0-9])','\1[identificador removido]','g');
$$;
create or replace function private.family_network_scrub_json(value jsonb) returns jsonb
language plpgsql immutable strict security invoker set search_path='' as $$
declare cleaned jsonb;
begin
 case jsonb_typeof(value)
 when 'string' then return to_jsonb(private.family_network_scrub_text(value#>>'{}'));
 when 'array' then
  select coalesce(jsonb_agg(private.family_network_scrub_json(v) order by ord),'[]'::jsonb) into cleaned from jsonb_array_elements(value) with ordinality a(v,ord);
 when 'object' then
  select coalesce(jsonb_object_agg(k,private.family_network_scrub_json(v)),'{}'::jsonb) into cleaned from jsonb_each(value) a(k,v);
 else return value;
 end case;
 return cleaned;
end $$;
create or replace function private.family_network_private_fields(value jsonb) returns boolean
language sql immutable security invoker set search_path='' as $$
 select exists(select 1 from jsonb_path_query(coalesce(value,'{}'::jsonb),'$.** ? (@.type() == "object").keyvalue()') v
 where lower(v->>'key') ~ '(cpf|age_group|faixa_etaria|birth|residen|personal_address|logradouro|bairro|telefone|email|representante)'
 or lower(v->>'key') in ('age','idade','address','cep','partner_identifier'))
 or private.family_network_scrub_text(coalesce(value::text,''))<>coalesce(value::text,'');
$$;
revoke all on function private.family_network_scrub_text(text),private.family_network_scrub_json(jsonb),private.family_network_private_fields(jsonb) from public,anon,authenticated;
grant execute on function private.family_network_scrub_text(text),private.family_network_scrub_json(jsonb),private.family_network_private_fields(jsonb) to service_role;
-- Minimize already persisted experimental network data only; preserve IDs,
-- review states, source attribution, retrieval dates and all core facts.
update public.candidate_entities set
 label=private.family_network_scrub_text(label),
 candidate_reason=private.family_network_scrub_text(candidate_reason),
 metadata=private.family_network_scrub_json(metadata)
where candidate_type in ('FAMILY_NETWORK_PIVOT','FAMILY_NETWORK_COMPANY','FAMILY_NETWORK_PERSON')
 and (label is distinct from private.family_network_scrub_text(label)
  or candidate_reason is distinct from private.family_network_scrub_text(candidate_reason)
  or metadata::text is distinct from private.family_network_scrub_text(metadata::text));
update public.evidence set title=private.family_network_scrub_text(title),excerpt=private.family_network_scrub_text(excerpt),raw_reference=private.family_network_scrub_text(raw_reference)
where dedupe_key like '%:family-network:%'
 and (title is distinct from private.family_network_scrub_text(title)
  or excerpt is distinct from private.family_network_scrub_text(excerpt)
  or raw_reference is distinct from private.family_network_scrub_text(raw_reference));
