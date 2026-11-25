// Database checks for the migrations of 2026-11-24 (AI allowance ledger, size and row limits, one
// running request, rows only the server writes), of 2026-11-25 (row limits that keep an account's
// newest rows instead of refusing: 20261125120000) and the hosted SQL files.
//
// Applies every migration in supabase/migrations, in order, to an in-process Postgres (PGlite)
// with a stub of Supabase's auth schema and API roles, then runs each check as the role the app
// uses (authenticated with a user's JWT claims, service_role, anon, the owner). It is not part of
// `npm test`: PGlite is not a dependency of the app, so install it in a scratch folder and run the
// script from there (it loads PGlite from the current folder):
//
//   mkdir lifeops-sql-check && cd lifeops-sql-check
//   npm install @electric-sql/pglite@0.6.0
//   node <repo>/supabase/tests/check-migrations.mjs <repo>
//   node <repo>/supabase/tests/check-migrations.mjs <repo> --no-default-grants
//
// --no-default-grants emulates a Supabase project created after 30 May 2026 (no automatic grants on
// new public tables); without it, the local stack and older projects (everything granted).
// Exit code 0 when every check passed.
//
// What it cannot check: PGlite is one connection, so parallel requests are not raced here (the
// checks only see that the allowance function holds its advisory lock while it counts); and
// pg_cron does not exist, so the hosted clean-up jobs run their commands directly. On 2026-11-24
// the same scenarios, the race (30 parallel calls) and the cron jobs were also run against the
// supabase/postgres 17.11 image with PostgREST; that setup is not kept in the repo.
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

// PGlite from the folder the script runs in (its ES module build, next to the CommonJS one).
const pgliteMain = createRequire(join(process.cwd(), "noop.js")).resolve("@electric-sql/pglite");
const { PGlite } = await import(pathToFileURL(join(dirname(pgliteMain), "index.js")).href);

const repo = process.argv[2];
const defaultGrants = !process.argv.includes("--no-default-grants");
if (!repo) throw new Error("repository path required");
const migrationsDir = join(repo, "supabase", "migrations");
const hostedFile = join(repo, "supabase", "hosted", "cleanup_anonymous_users.sql");
const closeStaleFile = join(repo, "supabase", "hosted", "close_stale_running_requests.sql");
const checkFile = join(repo, "supabase", "hosted", "check_before_20261124_migrations.sql");

const db = new PGlite();
let failures = 0;
let passes = 0;
function ok(cond, label, extra) {
  if (cond) {
    passes++;
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${extra !== undefined ? ` -> ${JSON.stringify(extra)}` : ""}`);
  }
}
async function expectError(label, fn, match) {
  try {
    await fn();
    failures++;
    console.log(`  FAIL ${label} -> no error`);
  } catch (e) {
    const text = `${e.code ?? ""} ${e.message}`;
    const good = match instanceof RegExp ? match.test(text) : text.includes(match);
    if (good) {
      passes++;
      console.log(`  ok   ${label} (${e.code ?? "?"}: ${e.message.slice(0, 90)})`);
    } else {
      failures++;
      console.log(`  FAIL ${label} -> ${text}`);
    }
  }
}
const one = async (sql, params) => (await db.query(sql, params)).rows[0];

async function asUser(uid) {
  await db.exec(`reset role`);
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [
    JSON.stringify({ sub: uid, role: "authenticated" }),
  ]);
  await db.exec(`set role authenticated`);
}
async function asService() {
  await db.exec(`reset role`);
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ role: "service_role" })]);
  await db.exec(`set role service_role`);
}
async function asAnon() {
  await db.exec(`reset role`);
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ role: "anon" })]);
  await db.exec(`set role anon`);
}
async function asOwner() {
  await db.exec(`reset role`);
  await db.query(`select set_config('request.jwt.claims', '', false)`);
}

// ---------------------------------------------------------------- Supabase stub
console.log(`PGlite ${(await one("select version()")).version}`);
console.log(`default grants on new public objects: ${defaultGrants}`);
await db.exec(`
  create role anon nologin noinherit;
  create role authenticated nologin noinherit;
  create role service_role nologin noinherit bypassrls;
  create schema auth;
  create table auth.users (
    id uuid primary key,
    email text,
    raw_user_meta_data jsonb,
    is_anonymous boolean not null default false,
    created_at timestamptz not null default now(),
    last_sign_in_at timestamptz
  );
  create table auth.sessions (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    created_at timestamptz default now(),
    updated_at timestamptz default now(),
    refreshed_at timestamp without time zone
  );
  create table auth.refresh_tokens (
    id bigserial primary key,
    user_id varchar(255),
    session_id uuid references auth.sessions(id) on delete cascade,
    created_at timestamptz default now(),
    updated_at timestamptz default now()
  );
  create function auth.uid() returns uuid language sql stable as $$
    select coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    )::uuid
  $$;
  grant usage on schema auth to anon, authenticated, service_role;
  grant execute on function auth.uid() to anon, authenticated, service_role;
  grant usage on schema public to anon, authenticated, service_role;
`);
if (defaultGrants) {
  await db.exec(`
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
    alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  `);
}

// ---------------------------------------------------------------- migrations
const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
const before = files.filter((f) => f < "20261124110200");
// 20261125120000 replaces refusing row limits; the accounts it unlocks are set up before it.
const after = files.filter((f) => f >= "20261124110200" && f < "20261125120000");
const later = files.filter((f) => f >= "20261125120000");
async function apply(list) {
  for (const f of list) {
    const sql = readFileSync(join(migrationsDir, f), "utf8");
    try {
      await db.exec(sql);
      console.log(`applied ${f}`);
    } catch (e) {
      console.log(`MIGRATION FAILED ${f}: ${e.code} ${e.message}`);
      process.exit(2);
    }
  }
}
await apply(before);

// Users: U1, U2 (anonymous), plus helpers.
const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
const U3 = "33333333-3333-4333-8333-333333333333";
await db.query(
  `insert into auth.users (id, email, raw_user_meta_data, is_anonymous) values
   ($1, null, '{"name":"Demo User"}', true), ($2, null, '{"name":"Demo User"}', true), ($3, 'c@example.com', $4, false)`,
  [U1, U2, U3, JSON.stringify({ name: "n".repeat(500) })],
);

console.log("\n[handle_new_user]");
ok((await one(`select char_length(name) n from public.profiles where id = $1`, [U3])).n === 100, "a 500-character sign-up name is cut to 100");

// Rows for the running-request migration (stale and duplicate running rows), as the owner.
const monday = "2026-11-23";
await db.query(
  `insert into public.week_plan_requests (user_id, week_start, status, created_at) values
   ($1, $2, 'running', now() - interval '3 hours'),
   ($1, $2, 'running', now() - interval '5 minutes'),
   ($1, $2, 'running', now() - interval '1 minute'),
   ($3, $2, 'running', now() - interval '2 minutes')`,
  [U1, monday, U2],
);
await db.query(
  `insert into public.planner_requests (user_id, input, status, created_at) values
   ($1, 'old', 'running', now() - interval '2 hours'),
   ($1, 'a', 'running', now() - interval '3 minutes'),
   ($1, 'b', 'running', now() - interval '1 minute'),
   ($2, 'c', 'running', now() - interval '1 minute')`,
  [U1, U2],
);
await apply(after);

// ---------------------------------------------------------------- an account at the old limits
// U4 used the demo for a long time: under 20261124110100 every one of these writes was refused for
// good (nothing in the app deletes the rows). 20261125120000 must let them through, keeping the
// newest rows.
const U4 = "44444444-4444-4444-8444-444444444444";
const S4 = "aaaaaaaa-0000-4000-8000-000000000004";
await db.query(`insert into auth.users (id, email, is_anonymous) values ($1, 'd@example.com', false)`, [U4]);
await db.query(`insert into public.chat_sessions (id, user_id) values ($1, $2)`, [S4, U4]);
await db.query(
  `insert into public.chat_messages (session_id, user_id, role, content, created_at)
   select $1, $2, case when g % 2 = 0 then 'assistant' else 'user' end, 'old ' || g, now() - interval '2 days' + g * interval '1 second'
     from generate_series(1, 1000) g`,
  [S4, U4],
);
await db.query(
  `insert into public.planner_requests (user_id, input, status, finished_at, created_at)
   select $1, 'old ' || g, 'done', now(), now() - interval '2 days' + g * interval '1 second' from generate_series(1, 200) g`,
  [U4],
);
await db.query(
  `insert into public.email_drafts (user_id, message_id, to_address, subject, body, provider, created_at)
   select $1, 'm' || g, 'a@b.c', 's', 'b', 'demo', now() - interval '2 days' + g * interval '1 second' from generate_series(1, 100) g`,
  [U4],
);
await db.query(
  `insert into public.week_plan_requests (user_id, week_start, status, created_at)
   select $1, date '2025-01-06' + 7 * (g % 60), 'done', now() - interval '2 days' + g * interval '1 second' from generate_series(1, 300) g`,
  [U4],
);
await db.query(
  `insert into public.weekly_plans (user_id, week_start, payload)
   select $1, date '2025-06-02' + 7 * g, '{"days":[]}' from generate_series(0, 51) g`,
  [U4],
);
// 1000 events that are all over (approved week plans, saved cards), the earliest 'past 1'.
await db.query(
  `insert into public.calendar_events (user_id, title, starts_at, ends_at, source)
   select $1, 'past ' || g, now() - interval '200 days' + g * interval '3 hours',
          now() - interval '200 days' + g * interval '3 hours' + interval '1 hour', 'plan'
     from generate_series(1, 1000) g`,
  [U4],
);

console.log("\n[before 20261125120000: an account at a limit is refused for good]");
{
  await asUser(U4);
  await expectError("chat message refused at 1000", () => db.query(`insert into public.chat_messages (session_id, user_id, role, content) values ($1, $2, 'user', 'hi')`, [S4, U4]), /23514/);
  await expectError("Plan it refused at 200", () => db.query(`insert into public.planner_requests (user_id, input, status) values ($1, 'plan', 'running')`, [U4]), /23514/);
  await expectError("draft refused at 100", () => db.query(`insert into public.email_drafts (user_id, message_id, to_address, subject, body, provider) values ($1, 'm', 'a@b.c', 's', 'b', 'demo')`, [U4]), /23514/);
  await expectError("week plan request refused at 300", () => db.query(`insert into public.week_plan_requests (user_id, week_start, kind) values ($1, '2026-11-30', 'create')`, [U4]), /23514/);
  await expectError("an event refused at 1000 events, all of them over", () => db.query(`insert into public.calendar_events (user_id, title, starts_at, ends_at) values ($1, 'new', now() + interval '1 day', now() + interval '1 day 1 hour')`, [U4]), /23514/);
  await asService();
  await expectError("the server's plan for a 53rd week refused (after the AI call)", () => db.query(`insert into public.weekly_plans (user_id, week_start, payload) values ($1, '2026-11-30', '{"days":[]}')`, [U4]), /23514/);
  await asOwner();
}

await apply(later);

console.log("\n[20261125120000: the same account can go on; its oldest rows make room]");
{
  await asUser(U4);
  await db.query(`insert into public.chat_messages (session_id, user_id, role, content) values ($1, $2, 'user', 'hi')`, [S4, U4]);
  await db.query(`insert into public.planner_requests (user_id, input, status) values ($1, 'plan', 'running')`, [U4]);
  await db.query(`insert into public.email_drafts (user_id, message_id, to_address, subject, body, provider) values ($1, 'm', 'a@b.c', 's', 'b', 'demo')`, [U4]);
  await db.query(`insert into public.week_plan_requests (user_id, week_start, kind) values ($1, '2026-11-30', 'create')`, [U4]);
  await db.query(`insert into public.calendar_events (user_id, title, starts_at, ends_at) values ($1, 'new', now() + interval '1 day', now() + interval '1 day 1 hour')`, [U4]);
  await asService();
  await db.query(
    `insert into public.weekly_plans (user_id, week_start, payload) values ($1, '2026-11-30', '{"days":[]}')
     on conflict (user_id, week_start) do update set payload = excluded.payload`,
    [U4],
  );
  ok(true, "chat message, Plan it, draft, week plan request, calendar event and the server's new week plan all accepted");
  await asOwner();
  const counts = await one(
    `select (select count(*)::int from public.chat_messages where user_id = $1) m,
            (select count(*)::int from public.planner_requests where user_id = $1) p,
            (select count(*)::int from public.email_drafts where user_id = $1) d,
            (select count(*)::int from public.week_plan_requests where user_id = $1) w,
            (select count(*)::int from public.weekly_plans where user_id = $1) wp,
            (select count(*)::int from public.calendar_events where user_id = $1) e`,
    [U4],
  );
  ok(counts.m === 1000 && counts.p === 200 && counts.d === 100 && counts.w === 300 && counts.wp === 52 && counts.e === 1000, "each table still holds exactly its limit", counts);
  ok(
    (await one(`select count(*)::int c from public.calendar_events where user_id = $1 and title in ('past 1', 'new')`, [U4])).c === 1 &&
      (await one(`select count(*)::int c from public.calendar_events where user_id = $1 and title = 'new'`, [U4])).c === 1,
    "the event that ended first made room for the new one",
  );
  ok((await one(`select count(*)::int c from public.chat_messages where user_id = $1 and content = 'old 1'`, [U4])).c === 0, "the oldest chat message made room");
  ok((await one(`select count(*)::int c from public.chat_messages where user_id = $1 and content = 'old 2'`, [U4])).c === 1, "only one message removed for one new one");
  ok((await one(`select count(*)::int c from public.planner_requests where user_id = $1 and input = 'old 1'`, [U4])).c === 0, "the oldest Plan it request made room");
  ok((await one(`select count(*)::int c from public.email_drafts where user_id = $1 and message_id = 'm1'`, [U4])).c === 0, "the oldest draft made room");
  ok((await one(`select count(*)::int c from public.weekly_plans where user_id = $1 and week_start = '2025-06-02'`, [U4])).c === 0, "the plan of the earliest week that is over made room");
  ok((await one(`select count(*)::int c from public.weekly_plans where user_id = $1 and week_start = '2026-11-30'`, [U4])).c === 1, "the new week's plan is stored");
}

console.log("\n[one running request: migration closes stale and duplicate rows]");
{
  const w = (await db.query(`select status, error from public.week_plan_requests where user_id = $1 order by created_at`, [U1])).rows;
  ok(w.map((r) => r.status).join() === "failed,failed,running", "week plans: only the newest running row stays running", w);
  ok(w[0].error === "This request was cut off before it finished.", "closed rows carry a visitor sentence");
  const p = (await db.query(`select status from public.planner_requests where user_id = $1 order by created_at`, [U1])).rows;
  ok(p.map((r) => r.status).join() === "failed,failed,running", "planner: only the newest running row stays running", p);
  ok((await one(`select count(*)::int c from public.planner_requests where user_id = $1 and status = 'running'`, [U2])).c === 1, "another user's running row is untouched");
}

// ---------------------------------------------------------------- ledger privileges
console.log("\n[ai_usage and ai_allowance privileges]");
const call = (u, kind, kinds, userLimit, windowS, globalLimit, consume) =>
  one(`select public.ai_allowance($1, $2, $3::text[], $4, $5, $6, $7) a`, [u, kind, kinds, userLimit, windowS, globalLimit, consume]).then((r) => r.a);
await asUser(U1);
await expectError("authenticated cannot execute ai_allowance", () => call(U1, "chat", ["chat", "draft"], 20, 3600, 150, true), /42501|permission denied/);
await expectError("authenticated cannot read ai_usage", () => db.query(`select * from public.ai_usage`), /42501|permission denied/);
await expectError("authenticated cannot insert ai_usage", () => db.query(`insert into public.ai_usage (user_id, kind) values ($1, 'chat')`, [U1]), /42501|permission denied/);
await expectError("authenticated cannot delete ai_usage", () => db.query(`delete from public.ai_usage`), /42501|permission denied/);
await asAnon();
await expectError("anon cannot execute ai_allowance", () => call(U1, "chat", ["chat", "draft"], 20, 3600, 150, true), /42501|permission denied/);
await asService();
await expectError("service_role cannot insert ai_usage directly", () => db.query(`insert into public.ai_usage (user_id, kind) values ($1, 'chat')`, [U1]), /42501|permission denied/);
ok((await call(U1, "chat", ["chat", "draft"], 20, 3600, 150, false)).allowed === true, "service_role can execute ai_allowance");
ok((await one(`select count(*)::int c from public.ai_usage`)).c === 0, "a read-only check records nothing");

// ---------------------------------------------------------------- ledger rules
console.log("\n[ai_allowance rules]");
{
  // user limit 3 per hour, chat and draft share it
  let r;
  for (let i = 0; i < 2; i++) r = await call(U1, "chat", ["chat", "draft"], 3, 3600, null, true);
  ok(r.recorded && r.user_count === 1, "second chat recorded with one earlier use", r);
  r = await call(U1, "draft", ["chat", "draft"], 3, 3600, null, true);
  ok(r.recorded && r.user_count === 2, "a reply draft counts with chat", r);
  r = await call(U1, "chat", ["chat", "draft"], 3, 3600, null, true);
  ok(!r.recorded && r.scope === "user" && r.user_count === 3, "fourth chat in the hour refused (user)", r);
  r = await call(U1, "plan", ["plan"], 3, 86400, null, true);
  ok(r.recorded && r.user_count === 0, "plans have their own count", r);
  r = await call(U2, "chat", ["chat", "draft"], 3, 3600, null, true);
  ok(r.recorded && r.user_count === 0, "another user has their own count", r);
  // global: 5 uses so far today
  r = await call(U2, "planner", ["planner"], null, 3600, 6, true);
  ok(r.recorded && r.global_count === 5, "sixth use today allowed (global 6)", r);
  r = await call(U3, "planner", ["planner"], null, 3600, 6, true);
  ok(!r.recorded && r.scope === "global" && r.global_count === 6, "seventh use today refused (global)", r);
  r = await call(U1, "chat", ["chat", "draft"], 3, 3600, 6, false);
  ok(r.scope === "user" && r.global_count === 0, "user over own limit: global not counted", r);
  // windows: an old use leaves the user window, a use from yesterday leaves the global day
  await asOwner();
  await db.query(`update public.ai_usage set created_at = now() - interval '61 minutes' where user_id = $1 and kind in ('chat','draft')`, [U1]);
  await db.query(`update public.ai_usage set created_at = now() - interval '23 hours' where user_id = $1 and kind = 'plan'`, [U1]);
  await asService();
  r = await call(U1, "chat", ["chat", "draft"], 3, 3600, null, false);
  ok(r.allowed && r.user_count === 0, "uses older than an hour leave the chat window", r);
  r = await call(U1, "plan", ["plan"], 1, 86400, null, false);
  ok(!r.allowed && r.user_count === 1, "a plan 23 hours ago still counts in the 24-hour window", r);
  await asOwner();
  const dayStart = (await one(`select date_trunc('day', now(), 'UTC') d`)).d;
  await db.query(`update public.ai_usage set created_at = $1::timestamptz - interval '1 second'`, [dayStart]);
  await asService();
  r = await call(U3, "planner", ["planner"], null, 3600, 6, false);
  ok(r.allowed && r.global_count === 0, "uses before midnight UTC leave the global count", r);
  await expectError("unknown kind refused", () => call(U1, "image", ["image"], 3, 3600, null, true), /22023|unknown request kind/);
  await expectError("missing user refused", () => call(null, "chat", ["chat"], 3, 3600, null, true), /22004|required/);
  // pruning
  await asOwner();
  await db.query(`insert into public.ai_usage (user_id, kind, created_at) values ($1, 'chat', now() - interval '3 days')`, [U2]);
  await asService();
  await call(U2, "chat", ["chat", "draft"], 100, 3600, null, true);
  await asOwner();
  ok((await one(`select count(*)::int c from public.ai_usage where created_at < now() - interval '2 days'`)).c === 0, "uses older than two days are pruned on the next recorded use");
}

console.log("\n[finding 5: rows the user writes do not move the limits]");
{
  await asOwner();
  await db.exec(`delete from public.ai_usage`);
  // U1 tries to block everyone: future-dated request rows (as the owner, since the user can no longer set created_at)
  await db.query(`insert into public.chat_sessions (id, user_id) values ('aaaaaaaa-0000-4000-8000-000000000001', $1)`, [U1]);
  await asService();
  for (let i = 0; i < 5; i++) await call(U1, "chat", ["chat", "draft"], 20, 3600, 5, true);
  let r = await call(U2, "chat", ["chat", "draft"], 20, 3600, 5, false);
  ok(!r.allowed && r.scope === "global", "five recorded uses fill a global limit of 5", r);
  // U1 deletes their own chat messages, sessions, requests: the ledger stays
  await asUser(U1);
  await db.query(`delete from public.chat_messages where user_id = $1`, [U1]);
  await db.query(`delete from public.chat_sessions where user_id = $1`, [U1]);
  await expectError("user cannot delete planner_requests any more", () => db.query(`delete from public.planner_requests where user_id = $1`, [U1]), /42501|permission denied/);
  await asService();
  r = await call(U1, "chat", ["chat", "draft"], 20, 3600, 5, false);
  ok(!r.allowed && r.scope === "global" && r.global_count === 5, "deleting own rows does not lower the global count", r);
  await asOwner();
  await db.exec(`delete from public.ai_usage`);
}

console.log("\n[ledger lock is held while a use is recorded]");
{
  await asService();
  await db.exec("begin");
  await call(U2, "chat", ["chat", "draft"], 20, 3600, 150, true);
  const locks = (await one(`select count(*)::int c from pg_locks where locktype = 'advisory' and pid = pg_backend_pid()`)).c;
  await db.exec("commit");
  ok(locks === 1, "one advisory lock taken inside the transaction", locks);
  const after = (await one(`select count(*)::int c from pg_locks where locktype = 'advisory' and pid = pg_backend_pid()`)).c;
  ok(after === 0, "released at commit", after);
  await asOwner();
  await db.exec(`delete from public.ai_usage`);
}

// ---------------------------------------------------------------- lengths
console.log("\n[length limits]");
{
  await asUser(U1);
  await expectError("goals of 2001 characters refused", () => db.query(`update public.profiles set goals = repeat('g', 2001) where id = $1`, [U1]), /23514|profiles_goals_length/);
  await db.query(`update public.profiles set goals = repeat('g', 2000), name = repeat('n', 100), role = repeat('r', 100) where id = $1`, [U1]);
  ok(true, "goals 2000, name 100, role 100 accepted");
  await expectError("name of 101 characters refused", () => db.query(`update public.profiles set name = repeat('n', 101) where id = $1`, [U1]), /23514/);
  await expectError("event title of 201 refused", () => db.query(`insert into public.calendar_events (user_id, title, starts_at, ends_at) values ($1, repeat('t', 201), now(), now() + interval '1 hour')`, [U1]), /23514/);
  await expectError("event notes of 2001 refused", () => db.query(`insert into public.calendar_events (user_id, title, notes, starts_at, ends_at) values ($1, 't', repeat('n', 2001), now(), now() + interval '1 hour')`, [U1]), /23514/);
  await db.query(`insert into public.calendar_events (user_id, title, notes, starts_at, ends_at) values ($1, repeat('t', 200), repeat('n', 2000), now(), now() + interval '1 hour')`, [U1]);
  ok(true, "event title 200, notes 2000 accepted");
  await expectError("draft body of 12001 refused", () => db.query(`insert into public.email_drafts (user_id, message_id, to_address, subject, body, provider) values ($1, 'm', 'a@b.c', 's', repeat('b', 12001), 'demo')`, [U1]), /23514/);
  await expectError("draft subject of 301 refused", () => db.query(`insert into public.email_drafts (user_id, message_id, to_address, subject, body, provider) values ($1, 'm', 'a@b.c', repeat('s', 301), 'b', 'demo')`, [U1]), /23514/);
  await expectError("draft recipient of 321 refused", () => db.query(`insert into public.email_drafts (user_id, message_id, to_address, subject, body, provider) values ($1, 'm', repeat('a', 321), 's', 'b', 'demo')`, [U1]), /23514/);
  await db.query(`insert into public.email_drafts (user_id, message_id, to_address, subject, body, provider) values ($1, 'm', repeat('a', 320), repeat('s', 300), repeat('b', 12000), 'demo')`, [U1]);
  ok(true, "draft at every limit accepted");
  await db.query(`insert into public.chat_sessions (id, user_id) values ('aaaaaaaa-0000-4000-8000-000000000002', $1)`, [U1]);
  await expectError("user message of 4001 characters refused (the chat form's limit)", () => db.query(`insert into public.chat_messages (session_id, user_id, role, content) values ('aaaaaaaa-0000-4000-8000-000000000002', $1, 'user', repeat('c', 4001))`, [U1]), /42501|row-level security/);
  await db.query(`insert into public.chat_messages (session_id, user_id, role, content) values ('aaaaaaaa-0000-4000-8000-000000000002', $1, 'user', repeat('c', 4000))`, [U1]);
  ok(true, "user message of 4000 characters accepted");
  await asService();
  await expectError("message of 12001 characters refused for the server too", () => db.query(`insert into public.chat_messages (session_id, user_id, role, content) values ('aaaaaaaa-0000-4000-8000-000000000002', $1, 'assistant', repeat('c', 12001))`, [U1]), /23514/);
  await db.query(`insert into public.chat_messages (session_id, user_id, role, content) values ('aaaaaaaa-0000-4000-8000-000000000002', $1, 'assistant', repeat('c', 12000))`, [U1]);
  ok(true, "assistant message of 12000 characters accepted (service role)");
  await asOwner();
  await db.query(`delete from public.chat_messages where user_id = $1`, [U1]);
  await asUser(U1);
  await expectError("user cannot insert a weekly plan any more", () => db.query(`insert into public.weekly_plans (user_id, week_start, payload) values ($1, '2026-11-23', '{}')`, [U1]), /42501|permission denied/);
  await expectError("connector provider of 51 refused", () => db.query(`insert into public.connector_status (user_id, provider) values ($1, repeat('p', 51))`, [U1]), /23514/);
  await asService();
  await expectError("weekly plan payload over 128 kB refused (server too)", () => db.query(`insert into public.weekly_plans (user_id, week_start, payload) values ($1, '2026-11-23', jsonb_build_object('x', repeat('p', 131072)))`, [U1]), /23514/);
  await db.query(`insert into public.weekly_plans (user_id, week_start, payload) values ($1, '2026-11-23', jsonb_build_object('x', repeat('p', 100000)))`, [U1]);
  ok(true, "service role stores a 100 kB plan");
  await asUser(U1);
  let up = await db.query(`update public.weekly_plans set payload = '{"days":[]}', approved_event_ids = '["e1"]' where user_id = $1 and week_start = '2026-11-23'`, [U1]);
  ok(up.affectedRows === 1, "the user's token still edits and approves its own plan", up.affectedRows);
  await expectError("user cannot grow a plan over 128 kB", () => db.query(`update public.weekly_plans set payload = jsonb_build_object('x', repeat('p', 131072)) where user_id = $1`, [U1]), /23514/);
  up = await db.query(`delete from public.weekly_plans where user_id = $1`, [U1]).catch((e) => e);
  ok(up instanceof Error && /permission denied/.test(up.message), "user cannot delete a plan", up.message);
  await asService();
  await expectError("tasks: title over 300 refused for the server too", () => db.query(`insert into public.tasks (user_id, title) values ($1, repeat('t', 301))`, [U1]), /23514/);
  await expectError("tasks: reason over 1000 refused", () => db.query(`insert into public.tasks (user_id, title, reason) values ($1, 't', repeat('r', 1001))`, [U1]), /23514/);
  await db.query(`insert into public.tasks (user_id, title, reason) values ($1, repeat('t', 300), repeat('r', 1000))`, [U1]);
  ok(true, "task at the limits accepted (service role)");
  // NOT VALID: an older over-long row stays readable
  await asOwner();
  await db.query(`alter table public.calendar_events disable trigger calendar_events_row_limit`);
  await db.query(`insert into public.calendar_events (user_id, title, starts_at, ends_at) select $1, 'ok', now(), now() + interval '1 hour'`, [U2]);
  ok((await one(`select count(*)::int c from pg_constraint where conname like '%_length' and not convalidated`)).c >= 15, "the length constraints are NOT VALID (existing rows not checked)");
  await db.query(`alter table public.calendar_events enable trigger calendar_events_row_limit`);
}

// ---------------------------------------------------------------- grants and policies
console.log("\n[rows only the server writes]");
{
  await asUser(U1);
  await expectError("user cannot insert tasks", () => db.query(`insert into public.tasks (user_id, title) values ($1, 't')`, [U1]), /42501|permission denied/);
  await expectError("user cannot update tasks", () => db.query(`update public.tasks set title = 'x' where user_id = $1`, [U1]), /42501|permission denied/);
  await expectError("user cannot delete tasks", () => db.query(`delete from public.tasks where user_id = $1`, [U1]), /42501|permission denied/);
  ok((await one(`select count(*)::int c from public.tasks`)).c === 1, "user still reads own tasks");

  await expectError("user cannot insert an assistant message", () => db.query(`insert into public.chat_messages (session_id, user_id, role, content) values ('aaaaaaaa-0000-4000-8000-000000000002', $1, 'assistant', 'forged')`, [U1]), /42501|row-level security/);
  await expectError("user cannot insert a message with a panel", () => db.query(`insert into public.chat_messages (session_id, user_id, role, content, panel_payload) values ('aaaaaaaa-0000-4000-8000-000000000002', $1, 'user', 'hi', '{"pendingEvents":[]}')`, [U1]), /42501|row-level security/);
  await db.query(`insert into public.chat_messages (session_id, user_id, role, content) values ('aaaaaaaa-0000-4000-8000-000000000002', $1, 'user', 'hello')`, [U1]);
  ok(true, "user inserts their own plain message");
  await expectError("user cannot post into another user's session", () => db.query(`insert into public.chat_messages (session_id, user_id, role, content) values ('aaaaaaaa-0000-4000-8000-000000000002', $1, 'user', 'x')`, [U2]), /42501|row-level security/);
  await asService();
  await db.query(`insert into public.chat_messages (session_id, user_id, role, content, panel_payload) values ('aaaaaaaa-0000-4000-8000-000000000002', $1, 'assistant', 'answer', '{"x":1}')`, [U1]);
  ok(true, "service role stores the assistant message with its panel");

  // card claims
  await asUser(U1);
  await db.query(`insert into public.chat_card_actions (user_id, card_id, status) values ($1, 'pending-1', 'saved')`, [U1]);
  let res = await db.query(`update public.chat_card_actions set result_id = 'ev-1' where user_id = $1 and card_id = 'pending-1'`, [U1]);
  ok(res.affectedRows === 1, "claim's result recorded with the user's token", res.affectedRows);
  res = await db.query(`delete from public.chat_card_actions where user_id = $1 and card_id = 'pending-1'`, [U1]);
  ok(res.affectedRows === 0, "a done claim cannot be deleted", res.affectedRows);
  res = await db.query(`update public.chat_card_actions set result_id = null where user_id = $1 and card_id = 'pending-1'`, [U1]);
  ok(res.affectedRows === 0, "a done claim cannot be reset", res.affectedRows);
  await expectError("a done card cannot be claimed again", () => db.query(`insert into public.chat_card_actions (user_id, card_id, status) values ($1, 'pending-1', 'saved')`, [U1]), /23505/);
  await db.query(`insert into public.chat_card_actions (user_id, card_id, status) values ($1, 'pending-2', 'saved')`, [U1]);
  res = await db.query(`delete from public.chat_card_actions where user_id = $1 and card_id = 'pending-2'`, [U1]);
  ok(res.affectedRows === 1, "a claim without a result is released (failed action)", res.affectedRows);
  await db.query(`insert into public.chat_card_actions (user_id, card_id, status) values ($1, 'pending-3', 'dismissed') on conflict (user_id, card_id) do nothing`, [U1]);
  ok(true, "dismiss (insert on conflict do nothing) still works");

  // week plan requests
  await db.query(`update public.week_plan_requests set status = status where false`).catch(() => {});
  await expectError("user cannot update week_plan_requests", () => db.query(`update public.week_plan_requests set status = 'done' where user_id = $1`, [U1]), /42501|permission denied/);
  await expectError("user cannot delete week_plan_requests", () => db.query(`delete from public.week_plan_requests where user_id = $1`, [U1]), /42501|permission denied/);
  await expectError("user cannot set created_at on a week plan request", () => db.query(`insert into public.week_plan_requests (user_id, week_start, created_at) values ($1, '2026-11-30', '2099-01-01')`, [U1]), /42501|permission denied/);
  await expectError("user cannot store a reply", () => db.query(`insert into public.week_plan_requests (user_id, week_start, reply) values ($1, '2026-11-30', 'x')`, [U1]), /42501|permission denied/);
  res = await db.query(`insert into public.week_plan_requests (user_id, week_start, kind, instructions) values ($1, '2026-11-30', 'create', null) returning id, status, created_at`, [U1]);
  ok(res.rows[0].status === "running", "the app's insert (user_id, week_start, kind, instructions) works and returns the row");
  await expectError("second running request for the same week -> 23505", () => db.query(`insert into public.week_plan_requests (user_id, week_start, kind, instructions) values ($1, '2026-11-30', 'refine', 'x')`, [U1]), /23505/);
  await db.query(`insert into public.week_plan_requests (user_id, week_start, kind) values ($1, '2026-12-07', 'create')`, [U1]);
  ok(true, "another week can run at the same time");
  await asService();
  await db.query(`update public.week_plan_requests set status = 'done' where user_id = $1 and week_start = '2026-11-30'`, [U1]);
  await asUser(U1);
  await db.query(`insert into public.week_plan_requests (user_id, week_start, kind) values ($1, '2026-11-30', 'refine')`, [U1]);
  ok(true, "after the server finished it, a new request starts");

  // planner requests
  await expectError("user cannot store a planner result", () => db.query(`insert into public.planner_requests (user_id, input, result) values ($1, 'x', '{}')`, [U1]), /42501|permission denied/);
  await expectError("user cannot insert a finished planner request", () => db.query(`insert into public.planner_requests (user_id, input, status) values ($1, 'x', 'done')`, [U1]), /42501|row-level security/);
  await expectError("user cannot set created_at on a planner request", () => db.query(`insert into public.planner_requests (user_id, input, created_at) values ($1, 'x', '2099-01-01')`, [U1]), /42501|permission denied/);
  await expectError("second running Plan it -> 23505", () => db.query(`insert into public.planner_requests (user_id, input, status) values ($1, 'plan', 'running') returning id, input, status, result, error, created_at, finished_at`, [U1]), /23505/);
  res = await db.query(`update public.planner_requests set status = 'failed', error = 'cut off', finished_at = now() where user_id = $1 and status = 'running' and created_at < now() + interval '1 day'`, [U1]);
  ok(res.affectedRows === 1, "the user's token may close its own interrupted request (status, error, finished_at)", res.affectedRows);
  await expectError("user cannot rewrite a planner result", () => db.query(`update public.planner_requests set result = '{}' where user_id = $1`, [U1]), /42501|permission denied/);
  await expectError("user cannot backdate a planner request", () => db.query(`update public.planner_requests set created_at = now() where user_id = $1`, [U1]), /42501|permission denied/);
  res = await db.query(`update public.planner_requests set status = 'running', error = null where user_id = $1 and status = 'failed'`, [U1]);
  ok(res.affectedRows === 0, "the user's token cannot reopen a finished request", res.affectedRows);
  res = await db.query(`update public.planner_requests set error = 'rewritten' where user_id = $1 and status <> 'running'`, [U1]);
  ok(res.affectedRows === 0, "the user's token cannot rewrite a finished request's error", res.affectedRows);
  res = await db.query(`insert into public.planner_requests (user_id, input, status) values ($1, 'plan', 'running') returning id, input, status, result, error, created_at, finished_at`, [U1]);
  ok(res.rows.length === 1, "the app's insert (user_id, input, status) works and returns the row");
  await expectError("the user's token can only mark a running request failed", () => db.query(`update public.planner_requests set status = 'done' where user_id = $1 and status = 'running'`, [U1]), /42501|row-level security/);
  await asUser(U2);
  res = await db.query(`update public.planner_requests set status = 'failed' where user_id = $1`, [U1]);
  ok(res.affectedRows === 0, "a user cannot close another user's request", res.affectedRows);
  await asService();
  await db.query(`update public.planner_requests set result = '{"mode":"service"}', status = 'done' where user_id = $1 and status = 'running'`, [U1]);
  ok(true, "service role stores the result");
}

// ---------------------------------------------------------------- row limits
console.log("\n[rows per user]");
{
  await asOwner();
  // Seven tables keep each account's newest rows (20261125120000); two refuse at their limit.
  const expected = {
    calendar_events: "keep_newest_user_rows 1000",
    chat_card_actions: "keep_newest_user_rows 900",
    chat_messages: "keep_newest_user_rows 1000",
    chat_sessions: "enforce_user_row_limit 100",
    connector_status: "enforce_user_row_limit 20",
    email_drafts: "keep_newest_user_rows 100",
    planner_requests: "keep_newest_user_rows 200",
    week_plan_requests: "keep_newest_user_rows 300",
    weekly_plans: "keep_newest_user_rows 52",
  };
  const triggers = (
    await db.query(
      `select c.relname as table_name, p.proname, encode(t.tgargs, 'escape') as args
         from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_proc p on p.oid = t.tgfoid
        where t.tgname like '%row_limit' and not t.tgisinternal`,
    )
  ).rows;
  const found = Object.fromEntries(triggers.map((r) => [r.table_name, `${r.proname} ${r.args.split("\\000")[0]}`]));
  const sorted = (o) => JSON.stringify(Object.entries(o).sort());
  ok(sorted(found) === sorted(expected), "the row limit and its kind on every table", found);
  const sentences = triggers.map((r) => r.args.split("\\000")[1]).filter(Boolean);
  ok(
    sentences.length === 5 && sentences.every((s) => /^This demo account has /.test(s) && !/_|clear the chat/i.test(s)),
    "every sentence is plain and names nothing the app does not offer",
    sentences,
  );
  ok((await one(`select count(*)::int c from pg_proc where proname = 'enforce_weekly_plan_limit'`)).c === 0, "the refusing week plan limit is gone");
  const fn = await one(`select prosecdef, proconfig from pg_proc where proname = 'keep_newest_user_rows'`);
  ok(fn.prosecdef === true && JSON.stringify(fn.proconfig) === JSON.stringify(["search_path=\"\""]), "keep_newest_user_rows runs as its owner with an empty search_path", fn);

  // Refusing limits: connector_status, chat_sessions, calendar_events.
  await asUser(U2);
  const rows = Array.from({ length: 20 }, (_, i) => `('${U2}', 'p${i}')`).join(",");
  await db.query(`insert into public.connector_status (user_id, provider) values ${rows}`);
  ok(true, "20 connector rows accepted in one statement");
  try {
    await db.query(`insert into public.connector_status (user_id, provider) values ($1, 'p20')`, [U2]);
    ok(false, "the 21st connector row refused");
  } catch (e) {
    ok(
      e.code === "23514" &&
        e.message === "This demo account has reached its limit of 20 connected services." &&
        e.detail === "Row limit 20 per user on public.connector_status.",
      "the 21st connector row refused with a plain sentence; the table is named only in the detail",
      { code: e.code, message: e.message, detail: e.detail },
    );
  }
  await asService();
  await db.query(`insert into public.connector_status (user_id, provider) values ($1, 'gmail')`, [U2]);
  ok(true, "the service role is not limited on a refusing table");
  await asUser(U3);
  const batch = Array.from({ length: 25 }, (_, i) => `('${U3}', 'q${i}')`).join(",");
  await expectError("one statement with 25 rows refused at row 21", () => db.query(`insert into public.connector_status (user_id, provider) values ${batch}`), /23514/);
  ok((await one(`select count(*)::int c from public.connector_status where user_id = $1`, [U3])).c === 0, "and nothing of it stored");
  await expectError("rows for another user still refused by the policy", () => db.query(`insert into public.connector_status (user_id, provider) values ($1, 'x')`, [U1]), /42501|row-level security/);
  await asUser(U2);
  const sess = Array.from({ length: 100 }, () => `('${U2}')`).join(",");
  await db.query(`insert into public.chat_sessions (user_id) values ${sess}`);
  await expectError("chat sessions limited to 100, without advice the app cannot follow", () => db.query(`insert into public.chat_sessions (user_id) values ($1)`, [U2]), /^23514 This demo account has reached its limit of 100 chat sessions\.$/);
  // calendar_events: only events that are over make room, the one that ended first first; an
  // event under way or still to come is never removed; the demo events go last.
  await asOwner();
  await db.query(`delete from public.calendar_events where user_id = $1`, [U2]);
  await db.query(
    `insert into public.calendar_events (user_id, title, starts_at, ends_at)
     select $1, 'e' || g, now() + g * interval '1 hour', now() + g * interval '1 hour' + interval '30 minutes' from generate_series(1, 1000) g`,
    [U2],
  );
  await asUser(U2);
  try {
    await db.query(`insert into public.calendar_events (user_id, title, starts_at, ends_at) values ($1, 'x', now(), now() + interval '1 hour')`, [U2]);
    ok(false, "with 1000 events still to come, the 1001st is refused");
  } catch (e) {
    ok(
      e.code === "23514" &&
        e.message === "This demo account has reached its limit of 1000 calendar events that are not over yet. Ask the assistant to cancel upcoming events you no longer need, or wait until some are over, then try again." &&
        e.detail === "Row limit 1000 per user on public.calendar_events.",
      "with 1000 events still to come, the 1001st is refused with what the visitor can do",
      { code: e.code, message: e.message, detail: e.detail },
    );
  }
  await asOwner();
  ok((await one(`select count(*)::int c from public.calendar_events where user_id = $1`, [U2])).c === 1000, "and no event still to come was removed");
  // e1 is under way, e2 ended two days ago, e3 one day ago.
  await db.query(`update public.calendar_events set starts_at = now() - interval '1 hour', ends_at = now() + interval '1 hour' where user_id = $1 and title = 'e1'`, [U2]);
  await db.query(`update public.calendar_events set starts_at = now() - interval '49 hours', ends_at = now() - interval '48 hours' where user_id = $1 and title = 'e2'`, [U2]);
  await db.query(`update public.calendar_events set starts_at = now() - interval '25 hours', ends_at = now() - interval '24 hours' where user_id = $1 and title = 'e3'`, [U2]);
  await asUser(U2);
  await db.query(`insert into public.calendar_events (user_id, title, starts_at, ends_at) values ($1, 'x', now() + interval '2000 hours', now() + interval '2001 hours')`, [U2]);
  await asOwner();
  const kept = (await db.query(`select title from public.calendar_events where user_id = $1 and title in ('e1', 'e2', 'e3', 'x') order by title`, [U2])).rows.map((r) => r.title);
  ok(
    JSON.stringify(kept) === JSON.stringify(["e1", "e3", "x"]) &&
      (await one(`select count(*)::int c from public.calendar_events where user_id = $1`, [U2])).c === 1000,
    "at 1000 events a new one is accepted: the event that ended first made room, the one under way stayed",
    kept,
  );
  // An account whose 1000 events are all over, the demo events among the earliest.
  const U6 = "66666666-6666-4666-8666-666666666666";
  await db.query(`insert into auth.users (id, is_anonymous) values ($1, false)`, [U6]);
  await db.query(
    `insert into public.calendar_events (user_id, title, starts_at, ends_at, source, seed_key)
     select $1, 'old ' || g, now() - interval '100 days' + g * interval '2 hours',
            now() - interval '100 days' + g * interval '2 hours' + interval '1 hour',
            case when g <= 4 then 'calendar' else 'plan' end,
            case g when 1 then 'team-sync' when 2 then 'lecture' when 3 then 'dentist' when 4 then 'acme-interview' end
       from generate_series(1, 1000) g`,
    [U6],
  );
  await asUser(U6);
  for (let i = 1; i <= 3; i++) {
    await db.query(`insert into public.calendar_events (user_id, title, starts_at, ends_at, source) values ($1, $2, now() + $3::int * interval '1 day', now() + $3::int * interval '1 day' + interval '1 hour', 'plan')`, [U6, `next ${i}`, i]);
  }
  await asOwner();
  const u6 = await one(
    `select count(*)::int c, count(*) filter (where seed_key is not null)::int seeds,
            count(*) filter (where title in ('old 5', 'old 6', 'old 7'))::int earliest_plan,
            count(*) filter (where title like 'next %')::int added
       from public.calendar_events where user_id = $1`,
    [U6],
  );
  ok(
    u6.c === 1000 && u6.seeds === 4 && u6.earliest_plan === 0 && u6.added === 3,
    "an account with 1000 past events adds three more: its three earliest past events (not the demo ones) made room",
    u6,
  );
  await db.query(`delete from auth.users where id = $1`, [U6]);

  // email_drafts: the newest 100 stay, a new draft is never refused.
  await asOwner();
  await db.query(
    `insert into public.email_drafts (user_id, message_id, to_address, subject, body, provider, created_at)
     select $1, 'm' || g, 'a@b.c', 's', 'b', 'demo', now() - interval '1 hour' + g * interval '1 second' from generate_series(0, 99) g`,
    [U2],
  );
  await asUser(U2);
  await db.query(`insert into public.email_drafts (user_id, message_id, to_address, subject, body, provider) values ($1, 'new', 'a@b.c', 's', 'b', 'demo')`, [U2]);
  ok((await one(`select count(*)::int c from public.email_drafts where user_id = $1`, [U2])).c === 100, "the 101st draft accepted, 100 stay");
  ok((await one(`select count(*)::int c from public.email_drafts where user_id = $1 and message_id = 'm0'`, [U2])).c === 0, "the oldest draft made room");
  // Another account's insert at U2's limit: refused by the policy, and nothing of U2's is removed.
  await asUser(U1);
  await expectError("a draft for another account refused", () => db.query(`insert into public.email_drafts (user_id, message_id, to_address, subject, body, provider) values ($1, 'x', 'a@b.c', 's', 'b', 'demo')`, [U2]), /42501|row-level security/);
  await asOwner();
  ok((await one(`select count(*)::int c from public.email_drafts where user_id = $1 and message_id = 'm1'`, [U2])).c === 1, "and none of that account's drafts removed");

  // chat_messages: 1000 rows per account, the server's answers included.
  const S3 = "aaaaaaaa-0000-4000-8000-000000000003";
  await asOwner();
  await db.query(`insert into public.chat_sessions (id, user_id) values ($1, $2)`, [S3, U3]);
  await db.query(
    `insert into public.chat_messages (session_id, user_id, role, content, created_at)
     select $1, $2, 'assistant', 'answer ' || g, now() - interval '1 hour' + g * interval '1 second' from generate_series(1, 999) g`,
    [S3, U3],
  );
  await asUser(U3);
  await db.query(`insert into public.chat_messages (session_id, user_id, role, content) values ($1, $2, 'user', 'message 1000')`, [S3, U3]);
  ok((await one(`select count(*)::int c from public.chat_messages where user_id = $1`, [U3])).c === 1000, "the 1000th message accepted, nothing removed");
  await db.query(`insert into public.chat_messages (session_id, user_id, role, content) values ($1, $2, 'user', 'one more')`, [S3, U3]);
  await asService();
  await db.query(`insert into public.chat_messages (session_id, user_id, role, content) values ($1, $2, 'assistant', 'its answer')`, [S3, U3]);
  await asOwner();
  const left = (await db.query(`select content from public.chat_messages where user_id = $1 order by created_at, id limit 1`, [U3])).rows[0].content;
  ok((await one(`select count(*)::int c from public.chat_messages where user_id = $1`, [U3])).c === 1000 && left === "answer 3", "the 1001st and 1002nd messages accepted (user and server), the two oldest removed", left);

  // chat_card_actions: 900 records; a new card makes room, a repeated one removes nothing.
  await db.query(
    `insert into public.chat_card_actions (user_id, card_id, status, result_id, created_at)
     select $1, 'card-' || g, 'saved', 'ev-' || g, now() - interval '1 hour' + g * interval '1 second' from generate_series(1, 900) g`,
    [U3],
  );
  await asService();
  await db.query(`insert into public.chat_card_actions (user_id, card_id, status) values ($1, 'card-new', 'saved')`, [U3]);
  await asOwner();
  ok((await one(`select count(*)::int c from public.chat_card_actions where user_id = $1`, [U3])).c === 900, "a new card claimed by the server at 900 records, 900 stay");
  ok((await one(`select count(*)::int c from public.chat_card_actions where user_id = $1 and card_id = 'card-1'`, [U3])).c === 0, "the oldest record made room");
  await asService();
  await db.query(`insert into public.chat_card_actions (user_id, card_id, status) values ($1, 'card-2', 'dismissed') on conflict (user_id, card_id) do nothing`, [U3]);
  await expectError("a second claim of a card still refused by the primary key", () => db.query(`insert into public.chat_card_actions (user_id, card_id, status) values ($1, 'card-3', 'saved')`, [U3]), /23505/);
  await asOwner();
  ok((await one(`select count(*)::int c from public.chat_card_actions where user_id = $1 and card_id in ('card-2', 'card-3')`, [U3])).c === 2, "a repeated card removes no other record");

  // Which records make room: dismissed ones first, so made-up dismissals cannot push out the record
  // of a saved card; saved and applied ones only when all are; a claim of the last hour last.
  const U7 = "77777777-7777-4777-8777-777777777777";
  await db.query(`insert into auth.users (id, is_anonymous) values ($1, false)`, [U7]);
  await db.query(
    `insert into public.chat_card_actions (user_id, card_id, status, result_id, created_at)
     select $1, 'saved-' || g, case when g % 2 = 0 then 'applied' else 'saved' end, 'ev-' || g, now() - interval '3 hours' + g * interval '1 second'
       from generate_series(1, 450) g`,
    [U7],
  );
  await db.query(
    `insert into public.chat_card_actions (user_id, card_id, status, created_at)
     select $1, 'dismissed-' || g, 'dismissed', now() - interval '2 hours' + g * interval '1 second' from generate_series(1, 450) g`,
    [U7],
  );
  await asService();
  await db.query(
    `insert into public.chat_card_actions (user_id, card_id, status) values ($1, 'made-up-0', 'dismissed') on conflict (user_id, card_id) do nothing`,
    [U7],
  );
  await asOwner();
  ok(
    (await one(`select count(*)::int c from public.chat_card_actions where user_id = $1 and card_id = 'dismissed-1'`, [U7])).c === 0 &&
      (await one(`select count(*)::int c from public.chat_card_actions where user_id = $1 and card_id = 'saved-1'`, [U7])).c === 1,
    "a new dismissal at 900 records removes the oldest dismissed record, not the older saved one",
  );
  await asService();
  for (let start = 1; start <= 1000; start += 250) {
    await db.query(
      `insert into public.chat_card_actions (user_id, card_id, status)
       select $1, 'made-up-' || g, 'dismissed' from generate_series($2::int, $2::int + 249) g
       on conflict (user_id, card_id) do nothing`,
      [U7, start],
    );
  }
  await asOwner();
  const u7 = await one(
    `select count(*)::int c, count(*) filter (where status <> 'dismissed')::int kept_saved from public.chat_card_actions where user_id = $1`,
    [U7],
  );
  ok(u7.c === 900 && u7.kept_saved === 450, "1000 made-up dismissals keep every record of a saved or applied card", u7);
  // All 900 saved or applied, one of them a claim of the last hour (oldest by time), one stale.
  await db.query(`delete from public.chat_card_actions where user_id = $1`, [U7]);
  await db.query(
    `insert into public.chat_card_actions (user_id, card_id, status, result_id, created_at) values
     ($1, 'running', 'saved', null, now() - interval '50 minutes'),
     ($1, 'stale', 'saved', null, now() - interval '5 hours')`,
    [U7],
  );
  await db.query(
    `insert into public.chat_card_actions (user_id, card_id, status, result_id, created_at)
     select $1, 'done-' || g, 'saved', 'ev-' || g, now() - interval '40 minutes' + g * interval '1 second' from generate_series(1, 898) g`,
    [U7],
  );
  await asService();
  await db.query(`insert into public.chat_card_actions (user_id, card_id, status) values ($1, 'next-1', 'saved')`, [U7]);
  await db.query(`insert into public.chat_card_actions (user_id, card_id, status) values ($1, 'next-2', 'saved')`, [U7]);
  await asOwner();
  const gone = (await db.query(
    `select x from unnest(array['running', 'stale', 'done-1', 'done-2', 'next-1', 'next-2']) x
      where not exists (select 1 from public.chat_card_actions where user_id = $1 and card_id = x)`,
    [U7],
  )).rows.map((r) => r.x).sort();
  ok(
    JSON.stringify(gone) === JSON.stringify(["done-1", "stale"]) &&
      (await one(`select count(*)::int c from public.chat_card_actions where user_id = $1`, [U7])).c === 900,
    "with only saved records the oldest go, a stale claim among them; a claim of the last hour stays",
    gone,
  );
  await db.query(`delete from auth.users where id = $1`, [U7]);

  // Requests: only finished ones are removed; all running, the new one is refused.
  const U5 = "55555555-5555-4555-8555-555555555555";
  await db.query(`insert into auth.users (id, is_anonymous) values ($1, true)`, [U5]);
  await db.query(
    `insert into public.week_plan_requests (user_id, week_start, status, created_at) values ($1, '2026-12-07', 'running', now() - interval '3 hours')`,
    [U5],
  );
  await db.query(
    `insert into public.week_plan_requests (user_id, week_start, status, created_at)
     select $1, '2026-12-14', 'done', now() - interval '2 hours' + g * interval '1 second' from generate_series(1, 299) g`,
    [U5],
  );
  await asUser(U5);
  await db.query(`insert into public.week_plan_requests (user_id, week_start, kind) values ($1, '2026-12-21', 'create')`, [U5]);
  await asOwner();
  const w5 = await one(
    `select count(*)::int c, count(*) filter (where week_start = '2026-12-07' and status = 'running')::int r from public.week_plan_requests where user_id = $1`,
    [U5],
  );
  ok(w5.c === 300 && w5.r === 1, "a finished request made room; the oldest row, still running, stays", w5);
  await db.query(`delete from public.week_plan_requests where user_id = $1`, [U5]);
  await db.query(
    `insert into public.week_plan_requests (user_id, week_start, status)
     select $1, date '2027-01-04' + 7 * g, 'running' from generate_series(0, 299) g`,
    [U5],
  );
  await asUser(U5);
  try {
    await db.query(`insert into public.week_plan_requests (user_id, week_start, kind) values ($1, '2026-12-21', 'create')`, [U5]);
    ok(false, "with 300 running requests a new one is refused");
  } catch (e) {
    ok(
      e.code === "23514" &&
        e.message === "This demo account has too many week plans being drafted. Wait for them to finish, then try again." &&
        e.detail === "Row limit 300 per user on public.week_plan_requests.",
      "with 300 running requests a new one is refused, with a sentence and the table in the detail",
      { code: e.code, message: e.message, detail: e.detail },
    );
  }
  await asOwner();
  await db.query(
    `insert into public.planner_requests (user_id, input, status, finished_at, created_at)
     select $1, 'p' || g, 'failed', now(), now() - interval '1 hour' + g * interval '1 second' from generate_series(1, 200) g`,
    [U5],
  );
  await asUser(U5);
  await db.query(`insert into public.planner_requests (user_id, input, status) values ($1, 'plan', 'running')`, [U5]);
  await expectError("a second running Plan it still refused by the unique index", () => db.query(`insert into public.planner_requests (user_id, input, status) values ($1, 'plan', 'running')`, [U5]), /23505/);
  await asOwner();
  ok(
    (await one(`select count(*)::int c from public.planner_requests where user_id = $1`, [U5])).c === 200 &&
      (await one(`select count(*)::int c from public.planner_requests where user_id = $1 and input = 'p1'`, [U5])).c === 0,
    "a new Plan it at 200 accepted; the oldest finished one made room",
  );
  await asUser(U5);
  await expectError("the user's token still cannot delete its requests itself", () => db.query(`delete from public.planner_requests where user_id = $1`, [U5]), /42501|permission denied/);

  // weekly_plans: weeks that are over go first; with none over, the plan changed longest ago.
  await asService();
  await db.query(
    `insert into public.weekly_plans (user_id, week_start, payload)
     select $1, (date_trunc('week', now())::date + 7) + 7 * g, '{"days":[]}' from generate_series(0, 51) g`,
    [U5],
  );
  await asOwner();
  // The update trigger sets updated_at itself; off for this one change.
  await db.exec(`alter table public.weekly_plans disable trigger weekly_plans_set_updated`);
  await db.query(`update public.weekly_plans set updated_at = now() - interval '1 day' where user_id = $1 and week_start = (date_trunc('week', now())::date + 7 * 20)`, [U5]);
  await db.exec(`alter table public.weekly_plans enable trigger weekly_plans_set_updated`);
  await asService();
  const replan = await db.query(
    `insert into public.weekly_plans (user_id, week_start, payload, approved_event_ids)
     values ($1, date_trunc('week', now())::date + 7, '{"days":[1]}', '[]')
     on conflict (user_id, week_start) do update set payload = excluded.payload, approved_event_ids = excluded.approved_event_ids
     returning payload`,
    [U5],
  );
  ok(replan.rows[0]?.payload?.days?.length === 1, "re-planning a week that has a plan works at the limit (upsert)", replan.rows);
  ok((await one(`select count(*)::int c from public.weekly_plans where user_id = $1`, [U5])).c === 52, "and removes no other plan");
  await db.query(`insert into public.weekly_plans (user_id, week_start, payload) values ($1, date_trunc('week', now())::date, '{"days":[]}')`, [U5]);
  await asOwner();
  ok(
    (await one(`select count(*)::int c from public.weekly_plans where user_id = $1`, [U5])).c === 52 &&
      (await one(`select count(*)::int c from public.weekly_plans where user_id = $1 and week_start = (date_trunc('week', now())::date + 7 * 20)`, [U5])).c === 0,
    "this week's plan stored at 52 future plans; the plan changed longest ago made room",
  );
  await db.query(`delete from auth.users where id = $1`, [U5]);
}

// ---------------------------------------------------------------- hosted: close cut-off requests
console.log("\n[hosted: close cut-off requests right before the new code ships]");
{
  await asOwner();
  await db.query(
    `insert into public.week_plan_requests (user_id, week_start, status, created_at) values
     ($1, '2027-01-04', 'running', now() - interval '20 minutes'),
     ($1, '2027-01-11', 'running', now() - interval '5 minutes')`,
    [U2],
  );
  await db.query(`insert into public.planner_requests (user_id, input, status, created_at) values ($1, 'cut off', 'running', now() - interval '20 minutes')`, [U3]);
  const closeSql = readFileSync(closeStaleFile, "utf8");
  await db.exec(closeSql);
  const weeks = (await db.query(`select week_start::text w, status from public.week_plan_requests where user_id = $1 and week_start >= '2027-01-04' order by week_start`, [U2])).rows;
  ok(JSON.stringify(weeks.map((r) => r.status)) === JSON.stringify(["failed", "running"]), "a week plan request older than 15 minutes is closed, a newer one keeps running", weeks);
  ok((await one(`select status from public.planner_requests where user_id = $1 and input = 'cut off'`, [U3])).status === "failed", "a cut-off Plan it request is closed");
  ok((await one(`select count(*)::int c from public.planner_requests where user_id = $1 and status = 'running'`, [U2])).c === 1, "another user's recent Plan it request keeps running");
  await db.exec(closeSql);
  ok(true, "runs a second time without error");
  await asUser(U2);
  await db.query(`insert into public.week_plan_requests (user_id, week_start, kind) values ($1, '2027-01-04', 'create')`, [U2]);
  ok(true, "after closing, a new request for that week starts (the unique index lets it in)");
}

// ---------------------------------------------------------------- hosted clean-up commands
console.log("\n[hosted clean-up commands]");
{
  await asOwner();
  const text = readFileSync(hostedFile, "utf8");
  const jobs = [...text.matchAll(/\$job\$([\s\S]*?)\$job\$/g)].map((m) => m[1]);
  ok(jobs.length === 2, "two job commands in the hosted file", jobs.length);
  const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // anonymous, old, session refreshed an hour ago
  const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"; // anonymous, old, unused for 8 days
  const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"; // e-mail user, old, unused
  const D = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"; // anonymous, old, only a refresh token 2 days ago
  const E = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"; // anonymous, 3 days old, unused since
  const F = "ffffffff-ffff-4fff-8fff-ffffffffffff"; // anonymous, old, signed in 1 day ago
  await db.query(
    `insert into auth.users (id, is_anonymous, created_at, last_sign_in_at) values
     ($1, true, now() - interval '10 days', now() - interval '10 days'),
     ($2, true, now() - interval '10 days', now() - interval '10 days'),
     ($3, false, now() - interval '30 days', now() - interval '30 days'),
     ($4, true, now() - interval '10 days', now() - interval '10 days'),
     ($5, true, now() - interval '3 days', now() - interval '3 days'),
     ($6, true, now() - interval '10 days', now() - interval '1 day')`,
    [A, B, C, D, E, F],
  );
  await db.query(
    `insert into auth.sessions (user_id, created_at, updated_at, refreshed_at) values
     ($1, now() - interval '10 days', now() - interval '10 days', (now() - interval '1 hour') at time zone 'UTC'),
     ($2, now() - interval '10 days', now() - interval '9 days', (now() - interval '9 days') at time zone 'UTC'),
     ($3, now() - interval '10 days', now() - interval '10 days', null)`,
    [A, B, D],
  );
  await db.query(`insert into auth.refresh_tokens (user_id, created_at, updated_at) values ($1, now() - interval '2 days', now() - interval '2 days'), ($2, now() - interval '9 days', now() - interval '9 days')`, [D, B]);
  await db.query(`insert into public.chat_sessions (user_id) values ($1), ($2)`, [A, B]);
  await db.exec(`create schema planner`);
  const plannerTables = ["planrun", "actionproposal", "task", "appsettings", "planidempotencykey"];
  for (const t of plannerTables) {
    // SQLModel writes str columns as varchar; one text column checks the other type.
    await db.exec(`create table planner.${t} (id serial primary key, owner ${t === "task" ? "text" : "varchar"} not null)`);
    await db.query(`insert into planner.${t} (owner) values ($1), ($2), ('local'), ('Local-Workspace'), ($3)`, [A, B, U1]);
  }
  await db.exec(`create table planner.alembic_like (id serial primary key, note text)`);
  await db.exec(`insert into planner.alembic_like (note) values ('kept')`);
  await db.exec(jobs[0]);
  const left = (await db.query(`select id from auth.users where id = any($1::uuid[]) order by id`, [[A, B, C, D, E, F]])).rows.map((r) => r.id);
  ok(JSON.stringify(left) === JSON.stringify([A, C, D, E, F]), "only the unused old anonymous user B is deleted", left);
  ok((await one(`select count(*)::int c from public.chat_sessions where user_id = $1`, [B])).c === 0, "B's app rows go with it (cascade)");
  ok((await one(`select count(*)::int c from public.chat_sessions where user_id = $1`, [A])).c === 1, "A's app rows stay");
  await db.exec(jobs[1]);
  for (const t of plannerTables) {
    const owners = (await db.query(`select owner from planner.${t} order by id`)).rows.map((r) => r.owner);
    ok(JSON.stringify(owners) === JSON.stringify([A, "local", "Local-Workspace", U1]), `planner.${t}: only B's rows deleted`, owners);
  }
  ok((await one(`select count(*)::int c from planner.alembic_like`)).c === 1, "a planner table without an owner column is left alone");
  await db.exec(`drop schema planner cascade`);
  await db.exec(jobs[1]);
  ok(true, "the planner job does nothing (no error) without the planner tables");
  // preview queries run as written
  const previews = text.split(/;\s*\n/).filter((s) => /^\s*(--[^\n]*\n\s*)*select count\(\*\)/.test(s));
  ok(previews.length === 1, "one preview query", previews.length);
  const pv = await one(previews[0]);
  ok(pv.anonymous_users_to_delete === 0 || Number(pv.anonymous_users_to_delete) === 0, "preview runs (nothing left to delete)", pv);
}

console.log("\n[hosted: read-only checks file]");
{
  await asOwner();
  const results = await db.exec(readFileSync(checkFile, "utf8"));
  ok(results.length === 4, "every query of the check file runs", results.length);
}

await asOwner();
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
