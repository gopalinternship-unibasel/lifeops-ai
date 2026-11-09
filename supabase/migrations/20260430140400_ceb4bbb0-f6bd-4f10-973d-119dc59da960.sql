create or replace function public.update_updated_at_column()
returns trigger language plpgsql set search_path = public as $$
begin new.updated_at = now(); return new; end; $$;

create table public.weekly_plans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  week_start date not null,
  payload jsonb not null,
  approved_event_ids jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, week_start)
);

alter table public.weekly_plans enable row level security;

create policy "weekly_plans_select_own" on public.weekly_plans for select using (auth.uid() = user_id);
create policy "weekly_plans_insert_own" on public.weekly_plans for insert with check (auth.uid() = user_id);
create policy "weekly_plans_update_own" on public.weekly_plans for update using (auth.uid() = user_id);
create policy "weekly_plans_delete_own" on public.weekly_plans for delete using (auth.uid() = user_id);

create trigger weekly_plans_set_updated
before update on public.weekly_plans
for each row execute function public.update_updated_at_column();