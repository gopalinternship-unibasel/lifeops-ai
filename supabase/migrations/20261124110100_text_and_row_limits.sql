-- Size limits for what a signed-in user can store.
--
-- Signed-in users (every demo visitor, through anonymous sign-in) can write their own rows through
-- the Data API, and the text and JSON columns had no limit: one visitor could store any amount in
-- the shared free database, and a very long profile or task text went into every AI prompt.
--
-- 1. CHECK constraints on the length of every text and JSON column a user can write. They are NOT
--    VALID: rows stored before this migration are not checked (and keep working), every new or
--    changed row is. The forms and the server keep within the same numbers (TEXT_LIMITS in
--    src/lib/validation.ts; the server trims what it writes).
-- 2. A per-user row limit on the tables a user can insert into, for writes made with the user's
--    own token, and on the week plans the server stores. The limits are well above what one
--    person uses in the app (the AI requests that create most of these rows are limited to a few
--    per hour, and to 150 a day for all visitors together on the hosted demo), and low enough that
--    one account cannot take a large share of the free database (500 MB).
--
-- The most one account can store through these tables, with every column at its limit:
--   calendar_events     1000 rows x  2350 characters (title, notes, source, seed_key)
--   chat_card_actions   1000 rows x  1133 (card id, status, result id)
--   chat_messages       1000 rows x  4000 (a message written with the user's token: at most
--                                          4000 characters, the chat form's limit; see
--                                          msgs_insert_own in 20261124110300)
--   email_drafts         100 rows x 13025 (subject, body, recipient, ids)
--   planner_requests     200 rows x  6007 (input, error)
--   week_plan_requests   300 rows x  1506 (kind, instructions)
--   chat_sessions 100 and connector_status 20 small rows, one profile of 2200 characters
--   together about 10.4 million characters: about 10 MB of plain text (2% of 500 MB), at most
--   about 42 MB if every character takes 4 bytes, plus some hundred bytes of row and index
--   overhead per row (under 2 MB). weekly_plans adds at most 52 plans x 192 kB (about 10 MB), and
--   each new plan needs an allowed AI request.
--   Assistant messages are written by the server, one per allowed AI request (limited as above).
-- Many accounts together can still store more: Supabase allows 30 anonymous sign-ins per hour
-- per IP address. Closing that needs a decision on the project's sign-up settings (a CAPTCHA,
-- lower sign-in limits) and is not done here.

-- New accounts: the name comes from the sign-up metadata (any length) or the e-mail address.
-- Cut it to the profile limit, so a long name never makes the sign-up itself fail.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, name)
  values (
    new.id,
    left(coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)), 100)
  );
  return new;
end;
$$;

-- 1. Length limits. char_length counts characters; NULL passes.
alter table public.profiles
  add constraint profiles_name_length check (char_length(name) <= 100) not valid,
  add constraint profiles_role_length check (char_length(role) <= 100) not valid,
  add constraint profiles_goals_length check (char_length(goals) <= 2000) not valid;

alter table public.tasks
  add constraint tasks_title_length check (char_length(title) <= 300) not valid,
  add constraint tasks_reason_length check (char_length(reason) <= 1000) not valid,
  add constraint tasks_source_length check (char_length(source) <= 50) not valid;

alter table public.calendar_events
  add constraint calendar_events_title_length check (char_length(title) <= 200) not valid,
  add constraint calendar_events_notes_length check (char_length(notes) <= 2000) not valid,
  add constraint calendar_events_source_length check (char_length(source) <= 50) not valid,
  add constraint calendar_events_seed_key_length check (char_length(seed_key) <= 100) not valid;

-- An assistant message's panel is written by the server only (see the insert policy in
-- 20261124110300); 256 kB is far above the largest panel it builds.
alter table public.chat_messages
  add constraint chat_messages_content_length check (char_length(content) <= 12000) not valid,
  add constraint chat_messages_panel_size
    check (panel_payload is null or octet_length(panel_payload::text) <= 262144) not valid;

alter table public.email_drafts
  add constraint email_drafts_subject_length check (char_length(subject) <= 300) not valid,
  add constraint email_drafts_body_length check (char_length(body) <= 12000) not valid,
  add constraint email_drafts_to_address_length check (char_length(to_address) <= 320) not valid,
  add constraint email_drafts_message_id_length check (char_length(message_id) <= 200) not valid,
  add constraint email_drafts_external_id_length
    check (char_length(external_draft_id) <= 200) not valid;

alter table public.chat_card_actions
  add constraint chat_card_actions_result_id_length check (char_length(result_id) <= 1024) not valid;

alter table public.connector_status
  add constraint connector_status_provider_length check (char_length(provider) <= 50) not valid;

-- The server stores the plan the model drafted (a model answer is at most a few thousand tokens,
-- about 20 kB); the user's token may still edit it (moving an item, approving). 128 kB leaves room
-- for six times that.
alter table public.weekly_plans
  add constraint weekly_plans_payload_size
    check (octet_length(payload::text) <= 131072) not valid,
  add constraint weekly_plans_approved_ids_size
    check (octet_length(approved_event_ids::text) <= 65536) not valid;

-- A user may still close their own stale "Plan it" request (status, error, finished_at; see
-- 20261124110300), so the error text needs a limit too. The server stores one sentence.
alter table public.planner_requests
  add constraint planner_requests_error_length check (char_length(error) <= 2000) not valid;

-- 2. Rows per user. The count reads only the user's own rows (an index on user_id each).
create index if not exists idx_chat_messages_user_created on public.chat_messages (user_id, created_at);
create index if not exists idx_chat_sessions_user_created on public.chat_sessions (user_id, created_at);

-- BEFORE INSERT trigger: refuse a row when the user already has TG_ARGV[0] rows in the table,
-- with the sentence TG_ARGV[1] (meant for the visitor; the table and the limit go in DETAIL).
-- Applies only to writes made as the authenticated role (the Data API, or the server acting with
-- the user's token); the server's service-role writes and maintenance jobs are not limited.
-- Runs with the caller's rights, so row level security limits the count to the caller's own rows;
-- a row for another user is refused by the insert policy anyway.
-- The trigger also fires for an insert that ON CONFLICT DO NOTHING then skips, so at the limit a
-- repeated claim or dismissal of the same chat card is refused too, with the same sentence.
create or replace function public.enforce_user_row_limit()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_limit integer := tg_argv[0]::integer;
  v_count integer;
begin
  if current_user <> 'authenticated' then
    return new;
  end if;
  -- One insert at a time per user and table, so parallel requests cannot pass the limit together.
  perform pg_advisory_xact_lock(
    hashtextextended(format('lifeops:rows:%s:%s', tg_table_name, new.user_id), 0)
  );
  execute format(
    'select count(*) from (select 1 from %I.%I where user_id = $1 limit $2) s',
    tg_table_schema,
    tg_table_name
  )
    into v_count
    using new.user_id, v_limit;
  if v_count >= v_limit then
    raise exception using
      errcode = '23514',
      message = coalesce(tg_argv[1], 'This demo account has reached its storage limit for this kind of item.'),
      detail = format('Row limit %s per user on %I.%I.', v_limit, tg_table_schema, tg_table_name);
  end if;
  return new;
end;
$$;

-- Only ever runs as a trigger (EXECUTE is checked when a trigger is created, not when it fires).
revoke all on function public.enforce_user_row_limit() from public, anon, authenticated;

drop trigger if exists calendar_events_row_limit on public.calendar_events;
create trigger calendar_events_row_limit before insert on public.calendar_events
  for each row execute function public.enforce_user_row_limit(
    '1000', 'This demo account has reached its limit of 1000 calendar events. Delete some older events to add new ones.'
  );

drop trigger if exists chat_card_actions_row_limit on public.chat_card_actions;
create trigger chat_card_actions_row_limit before insert on public.chat_card_actions
  for each row execute function public.enforce_user_row_limit(
    '1000', 'This demo account has reached its limit of 1000 handled chat suggestions.'
  );

-- Counts the assistant's answers too (written by the server, one per turn), so 1000 rows are
-- about 500 turns. Clearing the chat history deletes them.
drop trigger if exists chat_messages_row_limit on public.chat_messages;
create trigger chat_messages_row_limit before insert on public.chat_messages
  for each row execute function public.enforce_user_row_limit(
    '1000', 'This demo account has reached its limit of 1000 stored chat messages. Clear the chat history to continue.'
  );

drop trigger if exists chat_sessions_row_limit on public.chat_sessions;
create trigger chat_sessions_row_limit before insert on public.chat_sessions
  for each row execute function public.enforce_user_row_limit(
    '100', 'This demo account has reached its limit of 100 chat sessions. Clear the chat history to continue.'
  );

drop trigger if exists connector_status_row_limit on public.connector_status;
create trigger connector_status_row_limit before insert on public.connector_status
  for each row execute function public.enforce_user_row_limit(
    '20', 'This demo account has reached its limit of 20 connected services.'
  );

drop trigger if exists email_drafts_row_limit on public.email_drafts;
create trigger email_drafts_row_limit before insert on public.email_drafts
  for each row execute function public.enforce_user_row_limit(
    '100', 'This demo account has reached its limit of 100 saved email drafts.'
  );

drop trigger if exists planner_requests_row_limit on public.planner_requests;
create trigger planner_requests_row_limit before insert on public.planner_requests
  for each row execute function public.enforce_user_row_limit(
    '200', 'This demo account has reached its limit of 200 "Plan it" requests.'
  );

drop trigger if exists week_plan_requests_row_limit on public.week_plan_requests;
create trigger week_plan_requests_row_limit before insert on public.week_plan_requests
  for each row execute function public.enforce_user_row_limit(
    '300', 'This demo account has reached its limit of 300 week plan requests.'
  );

-- weekly_plans: only the server inserts plans (20261124110300), one per week a plan request was
-- allowed for, but the user's token may rewrite a plan up to the size limits above (192 kB). So the
-- number of weeks with a plan is limited as well, for every role: 52 weeks, a year of plans. A
-- plan for a week that already has one is an update (the server upserts on user_id, week_start)
-- and always goes through.
create or replace function public.enforce_weekly_plan_limit()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_limit integer := tg_argv[0]::integer;
  v_count integer;
begin
  -- One new plan at a time per user, so parallel requests cannot pass the limit together.
  perform pg_advisory_xact_lock(
    hashtextextended(format('lifeops:rows:%s:%s', tg_table_name, new.user_id), 0)
  );
  if exists (
    select 1 from public.weekly_plans where user_id = new.user_id and week_start = new.week_start
  ) then
    return new;
  end if;
  select count(*)
    into v_count
    from (select 1 from public.weekly_plans where user_id = new.user_id limit v_limit) s;
  if v_count >= v_limit then
    raise exception using
      errcode = '23514',
      message = format('This demo account has reached its limit of %s saved week plans.', v_limit),
      detail = format('Row limit %s per user on public.weekly_plans.', v_limit);
  end if;
  return new;
end;
$$;

revoke all on function public.enforce_weekly_plan_limit() from public, anon, authenticated;

drop trigger if exists weekly_plans_row_limit on public.weekly_plans;
create trigger weekly_plans_row_limit before insert on public.weekly_plans
  for each row execute function public.enforce_weekly_plan_limit('52');
