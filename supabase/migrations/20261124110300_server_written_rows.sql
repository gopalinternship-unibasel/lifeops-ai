-- Rows only the server should write.
--
-- A signed-in user (every demo visitor) could rewrite, through the Data API, rows that the server
-- trusts: insert assistant messages with any card in them, delete the record that a card was
-- already saved (and save it again), rewrite a request's stored result, backdate a request,
-- write the task list that goes into every chat prompt, and create plan rows for any week. Each
-- change below was checked against every place the app writes the table and the client it uses
-- (the user's token through src/integrations/supabase/auth-middleware.ts, or the service role,
-- supabaseAdmin); a right the app still uses with the user's token is kept. The AI limits no
-- longer count any of these rows (20261124110000), so deleting them changes nothing there.

-- tasks: written only by the chat turn, with the service role (chat-turn.server.ts, "store").
-- Users keep reading their tasks.
revoke insert, update, delete on table public.tasks from anon, authenticated;
drop policy if exists "tasks_insert_own" on public.tasks;
drop policy if exists "tasks_update_own" on public.tasks;
drop policy if exists "tasks_delete_own" on public.tasks;

-- chat_messages: the user's token inserts only the user's own message (role 'user', no panel);
-- assistant messages, their cards and failed turns are stored with the service role. Deleting
-- the own history (clearChatHistory) stays allowed.
drop policy if exists "msgs_insert_own" on public.chat_messages;
create policy "msgs_insert_own" on public.chat_messages
  for insert
  with check (
    auth.uid() = user_id
    and role = 'user'
    and panel_payload is null
    and exists (
      select 1
        from public.chat_sessions s
       where s.id = session_id
         and s.user_id = auth.uid()
    )
  );

-- chat_card_actions: a card is claimed (insert), its result recorded (update) and, when the action
-- failed, released again (delete), with the user's token. Once a result is recorded the card is
-- done: the user can no longer change or delete that record, so a saved card cannot be saved twice.
drop policy if exists "chat_card_actions_update_own" on public.chat_card_actions;
create policy "chat_card_actions_update_own" on public.chat_card_actions
  for update
  using (auth.uid() = user_id and result_id is null)
  with check (auth.uid() = user_id);
drop policy if exists "chat_card_actions_delete_own" on public.chat_card_actions;
create policy "chat_card_actions_delete_own" on public.chat_card_actions
  for delete
  using (auth.uid() = user_id and result_id is null);

-- week_plan_requests: the user's token inserts the request (user_id, week_start, kind,
-- instructions); its status, reply and error are stored with the service role, and nothing
-- deletes requests. status and created_at take their defaults ('running', now()).
revoke insert, update, delete on table public.week_plan_requests from anon, authenticated;
grant insert (user_id, week_start, kind, instructions) on table public.week_plan_requests to authenticated;
drop policy if exists "week_plan_requests_update_own" on public.week_plan_requests;
drop policy if exists "week_plan_requests_delete_own" on public.week_plan_requests;

-- planner_requests: the user's token inserts the request as running (user_id, input, status) and
-- may close its own interrupted request: a running row marked failed (status, error,
-- finished_at), which is all the dashboard does with it. The result is stored with the service role, and nothing deletes
-- requests. created_at always takes its default (now()).
revoke insert, update, delete on table public.planner_requests from anon, authenticated;
grant insert (user_id, input, status) on table public.planner_requests to authenticated;
grant update (status, error, finished_at) on table public.planner_requests to authenticated;
drop policy if exists "planner_requests_insert_own" on public.planner_requests;
create policy "planner_requests_insert_own" on public.planner_requests
  for insert
  with check (auth.uid() = user_id and status = 'running');
drop policy if exists "planner_requests_update_own" on public.planner_requests;
create policy "planner_requests_update_own" on public.planner_requests
  for update
  using (auth.uid() = user_id and status = 'running')
  with check (auth.uid() = user_id and status = 'failed');
drop policy if exists "planner_requests_delete_own" on public.planner_requests;

-- weekly_plans: plans are inserted only by the server, with the service role (the week plan
-- request stores the drafted plan); the user's token edits a plan (moving an item, approving it)
-- and never inserts or deletes one. So a user can no longer create plan rows for any week they
-- like, and the only plans that exist are ones a plan request was allowed for.
revoke insert, delete on table public.weekly_plans from anon, authenticated;
drop policy if exists "weekly_plans_insert_own" on public.weekly_plans;
drop policy if exists "weekly_plans_delete_own" on public.weekly_plans;
