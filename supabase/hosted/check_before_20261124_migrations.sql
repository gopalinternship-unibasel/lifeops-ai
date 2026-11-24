-- Read-only checks for the HOSTED project, to run in the SQL Editor before (and after) applying the
-- migrations 20261124110000 to 20261124110300. Nothing here changes data.

-- 1. Nothing of the ledger exists yet (both counts 0 before; 1 after).
select
  (select count(*) from pg_tables where schemaname = 'public' and tablename = 'ai_usage') as ai_usage_tables,
  (select count(*) from pg_proc where proname = 'ai_allowance' and pronamespace = 'public'::regnamespace) as ai_allowance_functions;

-- 2. Requests still marked running. 20261124110200 marks failed every running row older than an
--    hour, and every running row that has a newer running row of the same user (and week), so
--    that the unique indexes can be built. Before applying: look at what it will close.
select 'week_plan_requests' as table_name, count(*) filter (where created_at < now() - interval '1 hour') as older_than_an_hour,
       count(*) as running
  from public.week_plan_requests where status = 'running'
union all
select 'planner_requests', count(*) filter (where created_at < now() - interval '1 hour'), count(*)
  from public.planner_requests where status = 'running';

-- 3. Users already at or over a new per-user row limit (20261124110100). Such a user cannot add
--    rows to that table any more (the message names the limit). Expect no rows.
select 'calendar_events' as table_name, user_id, count(*) from public.calendar_events group by user_id having count(*) >= 1000
union all select 'chat_card_actions', user_id, count(*) from public.chat_card_actions group by user_id having count(*) >= 1000
union all select 'chat_messages', user_id, count(*) from public.chat_messages group by user_id having count(*) >= 1000
union all select 'chat_sessions', user_id, count(*) from public.chat_sessions group by user_id having count(*) >= 100
union all select 'connector_status', user_id, count(*) from public.connector_status group by user_id having count(*) >= 20
union all select 'email_drafts', user_id, count(*) from public.email_drafts group by user_id having count(*) >= 100
union all select 'planner_requests', user_id, count(*) from public.planner_requests group by user_id having count(*) >= 200
union all select 'week_plan_requests', user_id, count(*) from public.week_plan_requests group by user_id having count(*) >= 300
union all select 'weekly_plans', user_id, count(*) from public.weekly_plans group by user_id having count(*) >= 52;

-- 4. Rows longer than the new limits. The constraints are NOT VALID, so these rows stay and stay
--    readable, but they cannot be changed without being shortened. Expect zeros on a demo.
select
  (select count(*) from public.profiles where char_length(name) > 100 or char_length(role) > 100 or char_length(goals) > 2000) as profiles,
  (select count(*) from public.tasks where char_length(title) > 300 or char_length(reason) > 1000) as tasks,
  (select count(*) from public.calendar_events where char_length(title) > 200 or char_length(notes) > 2000) as calendar_events,
  (select count(*) from public.chat_messages where char_length(content) > 12000) as chat_messages,
  (select count(*) from public.chat_messages where role = 'user' and char_length(content) > 4000) as user_messages_over_4000,
  (select count(*) from public.email_drafts where char_length(subject) > 300 or char_length(body) > 12000 or char_length(to_address) > 320) as email_drafts,
  (select count(*) from public.weekly_plans where octet_length(payload::text) > 131072) as weekly_plans;

-- 5. After applying: the API roles cannot reach the ledger (expect only postgres and service_role
--    rows, service_role with SELECT only), and only the service role may run ai_allowance.
-- select grantee, privilege_type from information_schema.role_table_grants
--  where table_schema = 'public' and table_name = 'ai_usage' order by 1, 2;
-- select proacl from pg_proc where proname = 'ai_allowance';
-- select indexname from pg_indexes where indexname in ('week_plan_requests_one_running', 'planner_requests_one_running');
