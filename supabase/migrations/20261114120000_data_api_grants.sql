-- Data API grants.
--
-- Supabase projects created since 30 May 2026 no longer give the API roles access to new tables
-- in the public schema on their own. Without these grants every query from the app fails with
-- "permission denied for table ...". Row level security still decides which rows a signed-in
-- user can read or change; a grant only lets the role reach the table at all.
--
-- The local stack and older projects already hold these privileges, so running this there
-- changes nothing. The block does nothing where the Supabase roles do not exist.
--
-- anon gets nothing: the app signs every visitor in (anonymous sign-in counts as the
-- authenticated role) before it reads or writes a table.

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated')
     and exists (select 1 from pg_roles where rolname = 'service_role') then
    grant usage on schema public to authenticated, service_role;

    grant select, insert, update, delete on
      public.profiles,
      public.calendar_events,
      public.chat_card_actions,
      public.chat_messages,
      public.chat_sessions,
      public.connector_status,
      public.email_drafts,
      public.planner_requests,
      public.tasks,
      public.week_plan_requests,
      public.weekly_plans
    to authenticated, service_role;

    -- Google tokens are read and written by the server only, never by a signed-in browser session.
    grant select, insert, update, delete on public.google_oauth_tokens to service_role;

    grant usage, select on all sequences in schema public to authenticated, service_role;
  end if;
end
$$;
