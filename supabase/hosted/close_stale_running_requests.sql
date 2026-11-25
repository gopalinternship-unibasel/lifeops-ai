-- Close the "running" requests that the host cut off. For the HOSTED project, in the SQL Editor:
-- run it right before deploying the app code that goes with the migrations of 2026-11-24 (after
-- those migrations are applied). Safe to run more than once; it changes only rows that can no
-- longer finish.
--
-- Why: 20261124110200 allows one running request per user (and week). The app code from before
-- those migrations does not close a request the host cut off: the page shows it as interrupted,
-- and the next week plan or "Plan it" inserts a new running row, which the new unique index now
-- refuses (that code then shows a raw database error). The migration closed every such row once;
-- a request cut off after that stays "running" until the new code, which closes them itself, is
-- deployed. This closes them again just before, so the gap stays a few minutes.
--
-- 15 minutes is longer than any request can run on either host (Vercel stops a function after
-- 300 s, the Supabase Edge Function after 150 s, or 400 s on a paid plan), so a request that is
-- still running is never closed.

update public.week_plan_requests
   set status = 'failed',
       error = 'This request was cut off before it finished.',
       finished_at = coalesce(finished_at, now())
 where status = 'running'
   and created_at < now() - interval '15 minutes';

update public.planner_requests
   set status = 'failed',
       error = 'This request was cut off before it finished.',
       finished_at = coalesce(finished_at, now())
 where status = 'running'
   and created_at < now() - interval '15 minutes';
