-- Clean-up of old anonymous users, for the HOSTED Supabase project only.
--
-- This is deliberately not a migration: the local stack's image (supabase/postgres 17) has
-- pg_cron as well, so a migration would schedule the job on every local reset and delete local
-- anonymous test users. Run this file once in the hosted project's SQL Editor (or with psql as the
-- postgres role) after `supabase db push`.
--
-- The public demo signs a new anonymous user in for every visit, and Supabase never removes them.
-- This schedules a daily job (03:17 UTC) that deletes anonymous users older than 7 days. The
-- foreign keys on the app's tables cascade, so their chats, plans and events go with them. Rows
-- the planner keeps in its own schema are not linked to auth.users and stay.
--
-- Safe to run twice: the extension is created only if missing, and a job of the same name is
-- removed before it is scheduled again.

create extension if not exists pg_cron;

select cron.unschedule(jobid) from cron.job where jobname = 'delete-old-anonymous-users';

select cron.schedule(
  'delete-old-anonymous-users',
  '17 3 * * *',
  $job$delete from auth.users where is_anonymous and created_at < now() - interval '7 days'$job$
);

-- Check: one row, schedule 17 3 * * *.
select jobid, jobname, schedule, username, command from cron.job
where jobname = 'delete-old-anonymous-users';
