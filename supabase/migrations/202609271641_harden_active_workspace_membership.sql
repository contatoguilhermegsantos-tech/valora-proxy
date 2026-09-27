alter policy "profile self update" on public.profiles
  using (id = (select auth.uid()))
  with check (
    id = (select auth.uid())
    and (
      active_organization_id is null
      or private.is_org_member(active_organization_id)
    )
  );

create or replace function private.current_organization_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select p.active_organization_id
  from public.profiles p
  where p.id = (select auth.uid())
    and (
      p.active_organization_id is null
      or exists (
        select 1
        from public.organization_members m
        where m.organization_id = p.active_organization_id
          and m.user_id = (select auth.uid())
          and m.status = 'ACTIVE'
      )
    )
$$;
