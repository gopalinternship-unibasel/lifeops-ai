-- Optional clean-up of old anonymous users.
--
-- The public demo signs a new anonymous user in for every visit, and Supabase never removes them.
-- Where the pg_cron extension is available, this schedules a daily job (03:17 UTC) that deletes
-- anonymous users older than 7 days. The foreign keys on the app's tables cascade, so their
-- chats, plans and events go with them.
--
-- Where pg_cron is missing (the local stack) or cannot be enabled, this does nothing and only
-- prints a notice. Running it again replaces the job of the same name.

do $$
begin
  if not exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    raise notice 'pg_cron is not available here; old anonymous users are not cleaned up.';
    return;
  end if;

  begin
    create extension if not exists pg_cron;
    execute $job$
      select cron.schedule(
        'delete-old-anonymous-users',
        '17 3 * * *',
        'delete from auth.users where is_anonymous and created_at < now() - interval ''7 days'''
      )
    $job$;
  exception when others then
    raise notice 'Could not schedule the anonymous-user clean-up (%).', sqlerrm;
  end;
end
$$;
