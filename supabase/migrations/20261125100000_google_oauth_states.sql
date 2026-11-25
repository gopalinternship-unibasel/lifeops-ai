-- Single-use Google sign-ins.
--
-- A Google sign-in carries a signed state (src/server/google/oauth.server.ts). Its signature, its
-- ten-minute expiry and the checks in completeGoogleConnection (the same MONDAY account, the
-- browser that started it) decide who may finish it, but nothing on the server remembered whether
-- it had been finished already, so the same state could be finished again until it expired.
--
-- Now the server records each sign-in it starts here (the state's nonce, the account, the expiry)
-- and deletes the row when the sign-in is finished, in one DELETE ... RETURNING. A state without a
-- row (finished before, replaced by a newer sign-in of the same account, expired, or never issued
-- by this server) is refused. Starting a sign-in also removes expired rows, so the table only holds
-- sign-ins of the last ten minutes, at most one per account.
--
-- Only the server reads and writes this table: row level security is on with no policy, the API
-- roles anon and authenticated get no privileges, and the service role gets the three it uses.

create table if not exists public.google_oauth_states (
  -- SHA-256 (base64url) of the starting browser's key, as in the signed state: 43 characters.
  nonce text primary key check (char_length(nonce) <= 100),
  user_id uuid not null references auth.users (id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_google_oauth_states_user on public.google_oauth_states (user_id);
create index if not exists idx_google_oauth_states_expires on public.google_oauth_states (expires_at);

alter table public.google_oauth_states enable row level security;

-- The local stack (and projects created before 30 May 2026) give the API roles every privilege on
-- a new public table by default; take them away. Newer projects give none, so the service role's
-- privileges are granted here explicitly.
revoke all on table public.google_oauth_states from public, anon, authenticated;
revoke all on table public.google_oauth_states from service_role;
grant select, insert, delete on table public.google_oauth_states to service_role;

-- Let the Data API see the new table at once.
notify pgrst, 'reload schema';
