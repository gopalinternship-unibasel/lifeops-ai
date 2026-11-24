-- Clean-up of unused anonymous demo accounts, for the HOSTED Supabase project only.
--
-- This is deliberately not a migration: the local stack's image (supabase/postgres 17) has
-- pg_cron as well, so a migration would schedule the job on every local reset and delete local
-- anonymous test users. Run this file once in the hosted project's SQL Editor (or with psql as the
-- postgres role) after `supabase db push`. It replaces the jobs an earlier version scheduled.
--
-- "Try the live demo" signs a visitor in as an anonymous user, and the browser keeps that session
-- and refreshes it, so a visitor who comes back days later is still the same user. Supabase never
-- removes anonymous users. Two daily jobs:
--
-- 1. 03:17 UTC, delete-old-anonymous-users: deletes anonymous users that have not been used for 7
--    days: account older than 7 days, and no sign-in, no session and no refresh token created,
--    refreshed or updated in the last 7 days (the browser refreshes its token about every hour
--    while the demo is open, and on the next visit). It used to delete by account age alone, so a
--    visitor who used the demo every day lost everything on day 8. The foreign keys on the app's
--    tables cascade, so their chats, plans, events, drafts and AI usage rows go with them. The
--    sign-in page tells visitors that unused demo accounts are deleted after 7 days.
-- 2. 03:47 UTC, delete-orphaned-planner-rows: the planner service keeps its own tables in the
--    `planner` schema, keyed by the user id as text (column owner) without a foreign key, so they
--    were never deleted. This deletes, in every planner table with an owner column, the rows whose
--    owner is a user id that no longer exists (tables the planner adds later are covered too).
--    Rows of the shared "local" workspace (no user id) are kept. Without a planner schema (planner
--    not set up, or set to another schema) the job does nothing. It runs as postgres, which the
--    setup in VERCEL_DEPLOYMENT.md made a member of the planner role that owns those tables.
--
-- Safe to run twice: the extension is created only if missing, and a job of the same name is
-- removed before it is scheduled again. The preview queries at the start fail (and stop the
-- script) if this project's auth tables lack a column the job reads.

create extension if not exists pg_cron;

-- Preview: the anonymous users the first job would delete now (count only).
select count(*) as anonymous_users_to_delete
  from auth.users u
 where u.is_anonymous
   and u.created_at < now() - interval '7 days'
   and (u.last_sign_in_at is null or u.last_sign_in_at < now() - interval '7 days')
   and not exists (
     select 1
       from auth.sessions s
      where s.user_id = u.id
        and (
          s.created_at >= now() - interval '7 days'
          or s.updated_at >= now() - interval '7 days'
          or s.refreshed_at >= now() - interval '7 days'
        )
   )
   and not exists (
     select 1
       from auth.refresh_tokens rt
      where rt.user_id = u.id::text
        and (rt.created_at >= now() - interval '7 days' or rt.updated_at >= now() - interval '7 days')
   );

select cron.unschedule(jobid) from cron.job where jobname = 'delete-old-anonymous-users';

select cron.schedule(
  'delete-old-anonymous-users',
  '17 3 * * *',
  $job$
  delete from auth.users u
   where u.is_anonymous
     and u.created_at < now() - interval '7 days'
     and (u.last_sign_in_at is null or u.last_sign_in_at < now() - interval '7 days')
     and not exists (
       select 1
         from auth.sessions s
        where s.user_id = u.id
          and (
            s.created_at >= now() - interval '7 days'
            or s.updated_at >= now() - interval '7 days'
            or s.refreshed_at >= now() - interval '7 days'
          )
     )
     and not exists (
       select 1
         from auth.refresh_tokens rt
        where rt.user_id = u.id::text
          and (rt.created_at >= now() - interval '7 days' or rt.updated_at >= now() - interval '7 days')
     )
  $job$
);

select cron.unschedule(jobid) from cron.job where jobname = 'delete-orphaned-planner-rows';

select cron.schedule(
  'delete-orphaned-planner-rows',
  '47 3 * * *',
  $job$
  do $cleanup$
  declare
    t text;
  begin
    for t in
      select c.relname
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        join pg_attribute a on a.attrelid = c.oid
       where n.nspname = 'planner'
         and c.relkind in ('r', 'p')
         and a.attname = 'owner'
         and not a.attisdropped
         and a.atttypid in ('text'::regtype, 'character varying'::regtype)
       order by c.relname
    loop
      execute format(
        'delete from planner.%I p
          where p.owner ~ ''^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$''
            and not exists (select 1 from auth.users u where u.id::text = p.owner)',
        t
      );
    end loop;
  end
  $cleanup$
  $job$
);

-- Check: two rows, schedules 17 3 * * * and 47 3 * * *.
select jobid, jobname, schedule, username, command from cron.job
where jobname in ('delete-old-anonymous-users', 'delete-orphaned-planner-rows')
order by jobname;

-- After the first night: both runs should say "succeeded".
-- select j.jobname, d.status, d.return_message, d.start_time
--   from cron.job_run_details d join cron.job j using (jobid)
--  where j.jobname in ('delete-old-anonymous-users', 'delete-orphaned-planner-rows')
--  order by d.start_time desc limit 10;
