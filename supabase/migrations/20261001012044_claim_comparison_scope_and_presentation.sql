-- Presentation differences are not contradictions; company scope must match as well.
create or replace function public.max_detect_claim_contradiction() returns trigger
language plpgsql set search_path='' as $$
declare other_claim record;
begin
 if new.classification='FACT' and new.status='VERIFIED' then
  select c.* into other_claim from public.claims c
  where c.organization_id=new.organization_id and c.lead_id=new.lead_id and c.id<>new.id
   and c.company_id is not distinct from new.company_id
   and c.classification='FACT' and c.status='VERIFIED'
   and lower(btrim(c.subject_label))=lower(btrim(new.subject_label)) and c.predicate=new.predicate
   and lower(regexp_replace(btrim(coalesce(c.value_text,'')),'\s+',' ','g'))<>lower(regexp_replace(btrim(coalesce(new.value_text,'')),'\s+',' ','g'))
   and coalesce(c.valid_from,'0001-01-01'::date)<=coalesce(new.valid_to,'9999-12-31'::date)
   and coalesce(new.valid_from,'0001-01-01'::date)<=coalesce(c.valid_to,'9999-12-31'::date)
  order by c.created_at desc limit 1;
  if found then
   insert into public.divergences(organization_id,lead_id,claim_a_id,claim_b_id,field_key,value_a,value_b,status,created_by) values(new.organization_id,new.lead_id,other_claim.id,new.id,new.predicate,other_claim.value_text,new.value_text,'OPEN',new.created_by);
   update public.claims set status='CONTRADICTED' where id in(other_claim.id,new.id) and status='VERIFIED';
  end if;
 end if;
 return new;
end $$;
revoke all on function public.max_detect_claim_contradiction() from public,anon,authenticated;
