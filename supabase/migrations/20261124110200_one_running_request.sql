-- One running request at a time: one week plan request per user and week, one "Plan it" request
-- per user.
--
-- The app checked for a running request and then inserted its own in a separate round trip, so two
-- tabs (or a double click) both passed the check and both ran. A partial unique index makes the
-- second insert fail with unique_violation (23505); the app answers it with the same "still being
-- drafted" / "already running" sentence as its own check.
--
-- A request the host cut off (a server restart, a time limit) stays 'running' in the table. The
-- app closes such a row (older than the longest a request can take) before it inserts a new one.
-- Here, before each index is built, every running row older than an hour is closed the same way,
-- and of the rest only the newest per user (and week) stays running, so the index can be created.
-- The table is locked meanwhile, so no new running row slips in between.

do $$
begin
  lock table public.week_plan_requests in share row exclusive mode;

  update public.week_plan_requests r
     set status = 'failed',
         error = 'This request was cut off before it finished.',
         finished_at = coalesce(r.finished_at, now())
   where r.status = 'running'
     and (
       r.created_at < now() - interval '1 hour'
       or exists (
         select 1
           from public.week_plan_requests newer
          where newer.status = 'running'
            and newer.user_id = r.user_id
            and newer.week_start = r.week_start
            and (newer.created_at, newer.id) > (r.created_at, r.id)
       )
     );

  create unique index if not exists week_plan_requests_one_running
    on public.week_plan_requests (user_id, week_start)
    where status = 'running';
end
$$;

do $$
begin
  lock table public.planner_requests in share row exclusive mode;

  update public.planner_requests r
     set status = 'failed',
         error = 'This request was cut off before it finished.',
         finished_at = coalesce(r.finished_at, now())
   where r.status = 'running'
     and (
       r.created_at < now() - interval '1 hour'
       or exists (
         select 1
           from public.planner_requests newer
          where newer.status = 'running'
            and newer.user_id = r.user_id
            and (newer.created_at, newer.id) > (r.created_at, r.id)
       )
     );

  create unique index if not exists planner_requests_one_running
    on public.planner_requests (user_id)
    where status = 'running';
end
$$;
