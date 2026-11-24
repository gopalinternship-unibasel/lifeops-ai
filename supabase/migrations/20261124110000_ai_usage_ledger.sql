-- AI allowance ledger (the demo's AI_* limits).
--
-- The limits used to count rows of chat_messages, week_plan_requests and planner_requests. A
-- signed-in visitor can insert, backdate and delete those rows through the Data API, so the
-- counts could be lowered at will (no limit at all) or filled with future-dated rows (every
-- visitor of both editions refused). The count and the row it was taken from were also two
-- separate round trips, so parallel requests all passed a limit.
--
-- Now every AI request that is allowed records one row here, and only the server can write it:
-- no grant to anon or authenticated, row level security on with no policy, and the one way in is
-- public.ai_allowance(), which only the service role may execute. That function checks the limits
-- and records the use in one transaction, under a lock, so parallel requests are counted one at a
-- time.
--
-- A local install with no AI_* settings never calls the function and keeps no rows.

create table if not exists public.ai_usage (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('chat', 'plan', 'planner', 'draft')),
  created_at timestamptz not null default now()
);

-- The global count reads one UTC day; the per-user count reads one user's last hour or day.
create index if not exists idx_ai_usage_created on public.ai_usage (created_at);
create index if not exists idx_ai_usage_user_created on public.ai_usage (user_id, created_at);

alter table public.ai_usage enable row level security;

-- The local stack (and projects created before 30 May 2026) give the API roles every privilege on
-- a new public table by default; take them away. The service role may read the ledger (for a
-- look in the dashboard); only the function below writes it.
revoke all on table public.ai_usage from public, anon, authenticated;
revoke all on table public.ai_usage from service_role;
grant select on table public.ai_usage to service_role;
-- The same default grants reach the id sequence; nobody but the function below needs it.
revoke all on sequence public.ai_usage_id_seq from public, anon, authenticated, service_role;

-- Check the limits for one request and, with p_consume, record it when it is allowed.
--
--   p_user                 the signed-in user (the server's authenticated user id)
--   p_kind                 the request: chat, plan, planner or draft (a reply draft)
--   p_user_kinds           the kinds that share the user's limit (chat and draft share one)
--   p_user_limit           the user's limit in the window, or null for none
--   p_user_window_seconds  the user's window (3600 for an hour, 86400 for a day)
--   p_global_limit         requests of all users together since midnight UTC, or null for none
--   p_consume              false: only count; true: count and record one use when allowed
--
-- The user's limit is checked first, then the global one, as decideCap in
-- src/server/limits.server.ts does. Returns
--   {"allowed": bool, "scope": null | "user" | "global", "user_count": int,
--    "global_count": int, "recorded": bool}
-- where the counts are the uses before this request.
create or replace function public.ai_allowance(
  p_user uuid,
  p_kind text,
  p_user_kinds text[],
  p_user_limit integer,
  p_user_window_seconds integer,
  p_global_limit integer,
  p_consume boolean
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user_count integer := 0;
  v_global_count integer := 0;
  v_scope text := null;
  v_recorded boolean := false;
begin
  if p_user is null then
    raise exception 'ai_allowance: p_user is required' using errcode = '22004';
  end if;
  if p_kind is null or p_kind not in ('chat', 'plan', 'planner', 'draft') then
    raise exception 'ai_allowance: unknown request kind %', p_kind using errcode = '22023';
  end if;
  if p_user_limit is not null and (p_user_window_seconds is null or p_user_window_seconds <= 0) then
    raise exception 'ai_allowance: a user limit needs a positive window' using errcode = '22023';
  end if;

  if p_consume then
    -- One request at a time for the whole demo, until this transaction ends. Every count below is
    -- a new statement and so (in read committed, the Data API's level) sees the use the previous
    -- holder recorded. Without the lock, parallel requests all read the same old count.
    perform pg_advisory_xact_lock(hashtextextended('lifeops:ai_usage', 0));
    -- No window is longer than a day; older rows are never read again.
    delete from public.ai_usage where created_at < now() - interval '2 days';
  end if;

  if p_user_limit is not null then
    select count(*) into v_user_count
      from public.ai_usage u
     where u.user_id = p_user
       and u.kind = any (coalesce(p_user_kinds, array[p_kind]))
       and u.created_at >= now() - make_interval(secs => p_user_window_seconds);
    if v_user_count >= p_user_limit then
      v_scope := 'user';
    end if;
  end if;

  -- Not counted when the user is over their own limit already.
  if v_scope is null and p_global_limit is not null then
    select count(*) into v_global_count
      from public.ai_usage u
     where u.created_at >= date_trunc('day', now(), 'UTC');
    if v_global_count >= p_global_limit then
      v_scope := 'global';
    end if;
  end if;

  if p_consume and v_scope is null then
    insert into public.ai_usage (user_id, kind, created_at) values (p_user, p_kind, now());
    v_recorded := true;
  end if;

  return jsonb_build_object(
    'allowed', v_scope is null,
    'scope', v_scope,
    'user_count', v_user_count,
    'global_count', v_global_count,
    'recorded', v_recorded
  );
end;
$$;

-- Supabase gives EXECUTE on new public functions to anon and authenticated by default: only the
-- server may check or spend the allowance.
revoke all on function public.ai_allowance(uuid, text, text[], integer, integer, integer, boolean)
  from public, anon, authenticated;
grant execute on function public.ai_allowance(uuid, text, text[], integer, integer, integer, boolean)
  to service_role;

-- Let the Data API see the new function at once.
notify pgrst, 'reload schema';
