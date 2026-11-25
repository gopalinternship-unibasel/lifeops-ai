-- Row limits that bound storage without locking an account out.
--
-- 20261124110100 gave every account a limit of rows per table and refused a write over it. But
-- nothing the app offers deletes these rows: 20261124110300 took DELETE on requests and plans
-- away from the user's token, the server never deletes them, and clearing the chat history has
-- no button. So an account that kept using the demo (e-mail accounts are never cleaned up) lost
-- "Plan it", the chat, new week plans, saving drafts and handling chat suggestions for good once
-- it reached a limit, behind a message that said to try again. The week plan limit also fired
-- only when the server stored the plan, after the model had answered and the AI use was counted.
--
-- 1. The tables whose old rows the app no longer needs now keep each account's NEWEST rows: a new
--    row at the limit first removes that account's oldest rows, in the same transaction, for every
--    role (the server's own writes too, so the limit now bounds them as well):
--      calendar_events     1000  the events that ended first, never one that is not over yet.
--                                The app never deletes past events and has no control for it (the
--                                assistant only sees events from today to 21 days ahead, so it
--                                can only cancel those), and Save to Calendar,
--                                Plan it and approved week plans (up to 7 x 24 items each) add
--                                events all the time, so a refusing limit locked an active account
--                                out of adding events for good. Events with a seed_key go last:
--                                the four demo events (the app moves them forward while the demo
--                                inbox talks about them) and the blocks the dashboard's planner
--                                actions add ("planner-action-<id>", which keeps a second Run from
--                                adding the block twice).
--      chat_messages       1000  the oldest messages (the chat shows a session's newest 200)
--      chat_card_actions    900  the oldest records of handled chat suggestions, dismissed ones
--                                first, a claim of the last hour (an action still running) last.
--                                Below the server's own check of 1000 (CARD_ACTIONS_LIMIT in
--                                src/server/chat-cards.server.ts), which so no longer refuses
--      email_drafts         100  the oldest saved drafts (a draft in Gmail stays in Gmail)
--      planner_requests     200  the oldest finished "Plan it" requests, never a running one
--      week_plan_requests   300  the oldest finished week plan requests, never a running one
--      weekly_plans          52  first the plan of the earliest week that is over, otherwise the
--                                plan changed longest ago. A plan for a week that already has one
--                                replaces it (the server upserts) and removes nothing, so storing
--                                a plan after the model answered no longer fails on the limit.
--    A running request and an event that is not over are never removed. Only if no row of the
--    account can go is the new one refused, with a sentence that says what to do: for events, when
--    all 1000 are still to come (or under way), cancel upcoming ones or wait until some are over;
--    for requests, when all are running, wait (the app runs one "Plan it" and one request per week
--    at a time, 20261124110200, so it does not get there).
--    The record of a handled chat suggestion is what keeps a saved card from being offered (and
--    saved) again after a reload. Dismissed records go first, so dismissing made-up card ids (the
--    server takes any well-formed id) removes only dismissed records. A saved or applied record
--    goes only when all 900 are saved or applied ones; its card could then be offered again if its
--    message is still among the newest the chat shows, and a second save of it would add a second
--    event or draft. That takes some 900 real saves by the same account, and the copy lands only in
--    that account's own calendar or drafts: accepted.
-- 2. chat_sessions and connector_status keep refusing at their limits (100, 20). The app keeps one
--    chat session per account and one status row per service, so these limits are reached only by
--    writes outside the app. The sentences name only what the app offers (the chat ones said
--    "Clear the chat history", which the app has no control for).
-- 3. Every refusal keeps the same form (SQLSTATE 23514, the visitor's sentence as the message, and
--    "Row limit <n> per user on <schema>.<table>." as the detail), so the server can pass exactly
--    these sentences on to the visitor (dbError in src/server/public-error.server.ts).
--
-- The most one account can store through the tables a user writes, every column at its limit:
--   calendar_events     1000 rows x  2350 characters  =  2,350,000
--   chat_card_actions    900 rows x  1133             =  1,019,700
--   chat_messages       1000 rows x  4000 (written with the user's token)  =  4,000,000
--   email_drafts         100 rows x 13025             =  1,302,500
--   planner_requests     200 rows x  6007             =  1,201,400
--   week_plan_requests   300 rows x  1506             =    451,800
--   connector_status 20 x 50, chat_sessions 100 (no text), one profile of 2200
--   together 10,328,600 characters with chat rows at the 4000 a user can write. The assistant's
--   answers now share the same 1000 chat rows; an answer holds at most 12000 characters and needs
--   an allowed AI request, so if every chat row were a longest answer the sum is 18,328,600
--   characters: about 18 MB of plain text (3.7% of the free plan's 500 MB), at most about 73 MB if
--   every character takes 4 bytes, plus row and index overhead. Server-written weekly_plans come
--   on top: at most 52 x 192 kB (about 10 MB; each new plan needs an allowed AI request).
--   Calendar events and card records now keep their newest rows instead of refusing; their bound
--   per account is the same.
--
-- What changes for visitors: the database now removes an account's oldest rows of these tables
-- by itself: at 1000 events, each new event removes the event that ended first. Counts of stored
-- rows (the dashboard's chat message and draft counts) stop growing at these limits.

-- 1. Keep the newest rows. BEFORE INSERT trigger with TG_ARGV[0] = the rows to keep per account and
-- TG_ARGV[1] = the sentence for the case that no old row can be removed (events and requests).
-- SECURITY DEFINER: the user's token may not delete requests or plans, and the server's
-- service-role writes count too. It only ever removes rows of the account the new row belongs
-- to; a row for another account (which row level security refuses right after this trigger,
-- undoing the statement) removes nothing.
create or replace function public.keep_newest_user_rows()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limit integer := tg_argv[0]::integer;
  v_refusal text := tg_argv[1];
  v_caller uuid := auth.uid();
  v_key text := 'id';
  v_removable text := 'true';
  v_order text := 'created_at, id';
  v_count integer;
  v_excess integer;
  v_removed integer := 0;
begin
  if new.user_id is null or (v_caller is not null and v_caller <> new.user_id) then
    return new;
  end if;
  -- One insert at a time per account and table (the lock of enforce_user_row_limit), so
  -- parallel inserts cannot pass the limit together.
  perform pg_advisory_xact_lock(
    hashtextextended(format('lifeops:rows:%s:%s', tg_table_name, new.user_id), 0)
  );

  case tg_table_name
    when 'chat_messages', 'email_drafts' then
      null;
    when 'calendar_events' then
      -- Only events that are over, the one that ended first first; seeded events (demo events and
      -- planner blocks) last.
      v_removable := 'ends_at <= now()';
      v_order := 'seed_key is not null, ends_at, id';
    when 'chat_card_actions' then
      -- A second record of the same card is refused by the primary key (or skipped by ON
      -- CONFLICT DO NOTHING): it takes no room, so nothing is removed for it.
      if exists (
        select 1 from public.chat_card_actions where user_id = new.user_id and card_id = new.card_id
      ) then
        return new;
      end if;
      v_key := 'card_id';
      -- Dismissed records first, then saved and applied ones; a claim without a result from the
      -- last hour (its action may still be running) last. Oldest first within each.
      v_order := 'status <> ''dismissed'', (result_id is null and created_at > now() - interval ''1 hour''), '
        'created_at, card_id';
    when 'planner_requests', 'week_plan_requests' then
      v_removable := 'status <> ''running''';
    when 'weekly_plans' then
      -- A plan for a week that already has one becomes an update of it (the server upserts on
      -- user_id, week_start): nothing is removed.
      if exists (
        select 1 from public.weekly_plans where user_id = new.user_id and week_start = new.week_start
      ) then
        return new;
      end if;
      -- Weeks that are over first, earliest first; then the plan changed longest ago.
      v_order := 'week_start + 7 > current_date, '
        'case when week_start + 7 <= current_date then week_start end, updated_at, id';
    else
      raise exception 'keep_newest_user_rows: no rule for table %', tg_table_name;
  end case;

  -- Count at most 1000 rows past the limit, so an account far over it (rows from before these
  -- limits) costs a bounded amount of work per insert and still shrinks with every insert.
  execute format(
    'select count(*) from (select 1 from %I.%I where user_id = $1 limit $2) s',
    tg_table_schema, tg_table_name
  ) into v_count using new.user_id, v_limit + 1000;
  v_excess := v_count - v_limit + 1;
  if v_excess > 0 then
    execute format(
      'delete from %1$I.%2$I where user_id = $1 and %3$I = any(array('
        'select %3$I from %1$I.%2$I where user_id = $1 and %4$s order by %5$s limit $2))',
      tg_table_schema, tg_table_name, v_key, v_removable, v_order
    ) using new.user_id, v_excess;
    get diagnostics v_removed = row_count;
    if v_count - v_removed >= v_limit then
      raise exception using
        errcode = '23514',
        message = coalesce(v_refusal, 'This demo account has reached its storage limit for this kind of item.'),
        detail = format('Row limit %s per user on %I.%I.', v_limit, tg_table_schema, tg_table_name);
    end if;
  end if;
  return new;
end;
$$;

-- Only ever runs as a trigger.
revoke all on function public.keep_newest_user_rows() from public, anon, authenticated;

drop trigger if exists calendar_events_row_limit on public.calendar_events;
create trigger calendar_events_row_limit before insert on public.calendar_events
  for each row execute function public.keep_newest_user_rows(
    '1000', 'This demo account has reached its limit of 1000 calendar events that are not over yet. Ask the assistant to cancel upcoming events you no longer need, or wait until some are over, then try again.'
  );

drop trigger if exists chat_messages_row_limit on public.chat_messages;
create trigger chat_messages_row_limit before insert on public.chat_messages
  for each row execute function public.keep_newest_user_rows('1000');

drop trigger if exists chat_card_actions_row_limit on public.chat_card_actions;
create trigger chat_card_actions_row_limit before insert on public.chat_card_actions
  for each row execute function public.keep_newest_user_rows('900');

drop trigger if exists email_drafts_row_limit on public.email_drafts;
create trigger email_drafts_row_limit before insert on public.email_drafts
  for each row execute function public.keep_newest_user_rows('100');

drop trigger if exists planner_requests_row_limit on public.planner_requests;
create trigger planner_requests_row_limit before insert on public.planner_requests
  for each row execute function public.keep_newest_user_rows(
    '200', 'This demo account has a "Plan it" request still running. Wait for it to finish, then try again.'
  );

drop trigger if exists week_plan_requests_row_limit on public.week_plan_requests;
create trigger week_plan_requests_row_limit before insert on public.week_plan_requests
  for each row execute function public.keep_newest_user_rows(
    '300', 'This demo account has too many week plans being drafted. Wait for them to finish, then try again.'
  );

drop trigger if exists weekly_plans_row_limit on public.weekly_plans;
create trigger weekly_plans_row_limit before insert on public.weekly_plans
  for each row execute function public.keep_newest_user_rows('52');
drop function if exists public.enforce_weekly_plan_limit();

-- 2. The limits that still refuse, with sentences that name only what the app offers.
drop trigger if exists chat_sessions_row_limit on public.chat_sessions;
create trigger chat_sessions_row_limit before insert on public.chat_sessions
  for each row execute function public.enforce_user_row_limit(
    '100', 'This demo account has reached its limit of 100 chat sessions.'
  );
