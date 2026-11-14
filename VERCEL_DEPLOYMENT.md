# Deploying MONDAY (LifeOps AI) to Vercel

This describes the hosted setup the code is prepared for. Nothing here has been deployed yet: the
build, the tests and the migrations were checked on a PC, the live steps were not. Items that are
not verified are marked "Not verified".

## 1. What runs where

| Part | Where | Notes |
| --- | --- | --- |
| Web app (TanStack Start, React) | Vercel project `lifeops-ai`, root directory = repository root | One function for server rendering and server functions, static files from the CDN. Node 22.x. |
| Planner (FastAPI) | Vercel project `lifeops-planner`, root directory = `fastapi-backend` | Python 3.13 function, entry point `app/main.py` (`app`). Only the web app's server calls it. |
| Database and sign-in | A new Supabase project (free plan), region Frankfurt | The 13 migrations (12 older ones plus the new grants migration), then the one-off clean-up file `supabase/hosted/cleanup_anonymous_users.sql`. The planner uses the same project through its own role and schema. |
| AI model | Any OpenAI-compatible provider, set by `LLM_BASE_URL` | Not decided. Groq's free plan is the candidate. See section 2. |
| Monitoring | GitHub Actions workflow `smoke.yml` | Once a day. |

The web app is a full-stack app. It is not a static site: do not set an Output Directory and do not add
a catch-all rewrite. The Lovable wrapper that wraps `vite.config.ts` does not make the build ready for
Vercel by itself. The `nitro` package does, and `vite.config.ts` turns it on only when a target is named:

- `npm run build` with no target: the plain TanStack Start output in `dist/`, as before (used locally and
  in CI). `nitro` is not used.
- `NITRO_PRESET=vercel npm run build`: writes `.vercel/output` (Vercel's Build Output API). On Vercel the
  variable `VERCEL=1` is set by Vercel itself and selects the same preset, so `NITRO_PRESET` is optional
  there. `nitro` is pinned to an exact version in `package.json`; an `overrides` entry lets the Lovable
  wrapper accept it, because the wrapper's version range does not name release candidates.

## 2. The AI provider

The code is provider-neutral: three settings choose it (`LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY`), in
both Vercel projects.

- Do not use a free Google Gemini key for a public demo. Google's terms allow only paid services for apps
  offered to users in the EEA, and the clause also names Switzerland and the UK; the free tier also lets
  reviewers read inputs.
- Groq is the candidate: `LLM_BASE_URL=https://api.groq.com/openai/v1`. Its free-plan terms and exact
  limits are shown only in the owner's console. Read them before going public (section 6, step 1).
- If the provider is changed, only `LLM_BASE_URL`, `LLM_MODEL`, `LLM_FALLBACK_MODEL` and `LLM_API_KEY`
  change. Messages name the provider from its host (Groq, Cerebras, OpenRouter, Together AI, Mistral,
  OpenAI, Hugging Face, Google Gemini) and say "the AI provider" for any other host.
- Structured answers: the web app uses `LLM_STRUCTURED_OUTPUT=tools` (a forced function call) and the
  planner `LLM_RESPONSE_FORMAT=json_object`. Groq supports `json_schema` only on a few models, none of the
  Llama ones. Not verified: that forced function calls work on the Groq Llama models. If the first live chat
  turn returns no card, switch to a model with `json_schema` support and `LLM_STRUCTURED_OUTPUT=json_schema`.
- A rate-limit answer (HTTP 429) from the main model makes the app try `LLM_FALLBACK_MODEL`, because hosted
  providers count the limit per model.

## 3. Settings

### 3.1 Web project `lifeops-ai` (Vercel, Production)

Settings that begin with `VITE_` are read when the app is built and end up in the browser. Everything else
is read by the server at run time. Change a setting, then redeploy.

| Setting | Value | Secret | Meaning |
| --- | --- | --- | --- |
| `VITE_SUPABASE_URL` | `https://PROJECT_REF.supabase.co` | no | Supabase project URL (browser). |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | `sb_publishable_...` | no | Publishable key (browser). |
| `SUPABASE_URL` | same as `VITE_SUPABASE_URL` | no | Same URL for the server. |
| `SUPABASE_PUBLISHABLE_KEY` | same as `VITE_SUPABASE_PUBLISHABLE_KEY` | no | Same key for the server. |
| `SUPABASE_SECRET_KEY` | `sb_secret_...` | yes | Server-only key. Never put it in a `VITE_` setting. |
| `VITE_ENABLE_ANONYMOUS_DEMO` | `true` | no | Shows "Try the live demo" (anonymous sign-in). |
| `VITE_ENABLE_GOOGLE_SIGNIN` | `false` | no | Hides "Continue with Google". |
| `VITE_HOSTED_DEMO` | `true` | no | Shows the one-line demo notice on the sign-in page. Leave unset locally. |
| `LLM_BASE_URL` | for example `https://api.groq.com/openai/v1` | no | The provider's OpenAI-compatible URL. |
| `LLM_API_KEY` | the provider's key | yes | |
| `LLM_MODEL` | for example `llama-3.3-70b-versatile` | no | Main model for chat and plans. |
| `LLM_FALLBACK_MODEL` | for example `llama-3.1-8b-instant` | no | Tried after 401, 403, 404, 429 or 503 from the main model. |
| `LLM_STRUCTURED_OUTPUT` | `tools` | no | `tools` or `json_schema` (see section 2). |
| `LLM_TIMEOUT_MS` | `60000` | no | Time allowed for one model call. A chat turn can take up to twice this plus 2 minutes (main model, then fallback). |
| `LLM_MAX_TOKENS` | `1200` | no | Longest chat answer. |
| `LLM_MAX_TOKENS_PLAN` | `2400` | no | Longest week plan. |
| `LIFEOPS_BACKEND_URL` | `https://lifeops-planner.vercel.app` | no | The planner's address. `off` turns the planner off and the dashboard uses the in-app assistant. |
| `LIFEOPS_BACKEND_TOKEN` | a random value | yes | Shared with the planner (same value in both projects). |
| `LIFEOPS_BACKEND_TIMEOUT_MS` | `60000` | no | Time allowed for "Plan it". Default: `LLM_TIMEOUT_MS` plus 30 s. |
| `LIFEOPS_BACKEND_DASHBOARD_TIMEOUT_MS` | `10000` | no | Time allowed for the planner's quick calls (dashboard read, approve, reject). Default 10000; a planner that was idle needs a cold start. |
| `AI_CHAT_PER_HOUR` | `20` | no | See section 4. Unset = no limit. |
| `AI_PLANS_PER_DAY` | `10` | no | See section 4. |
| `AI_PLANNER_PER_HOUR` | `10` | no | See section 4. |
| `AI_CALLS_PER_DAY` | `800` | no | See section 4. Keep it below the provider's requests-per-day limit. |
| `NITRO_PRESET` | `vercel` | no | Build target. Optional on Vercel, which sets `VERCEL=1`. |

Leave these unset: `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_STATE_SECRET`,
`GOOGLE_OAUTH_REDIRECT_URI` (Gmail and Calendar stay off; the demo inbox and calendar are used and the
Connectors page says Google is not configured), `HUGGINGFACE_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`,
`LLM_MODEL_CHAT`, `LLM_MODEL_PLAN`, `LLM_MODEL_DRAFT` (they inherit `LLM_MODEL`) and `LLM_TEMPERATURE`.

### 3.2 Planner project `lifeops-planner` (Vercel, Production)

| Setting | Value | Secret | Meaning |
| --- | --- | --- | --- |
| `ENV` | `production` | no | Turns off SQL logging. |
| `DATABASE_URL` | `postgresql+psycopg://lifeops_planner.PROJECT_REF:PASSWORD@POOLER_HOST:5432/postgres?sslmode=require` | yes | Supabase session pooler, planner role. `postgres://` and `postgresql://` are also accepted. |
| `DATABASE_SCHEMA` | `planner` | no | Optional. Every connection puts this schema first on its `search_path`. The role already has the same default, so this is a second safeguard. The schema must exist. |
| `FRONTEND_ORIGIN` | `https://lifeops-ai.vercel.app` | no | For CORS. Only the web app's server calls the planner, so CORS is not used in practice. |
| `LLM_BASE_URL` | same as the web app | no | |
| `LLM_API_KEY` | same key | yes | |
| `LLM_MODEL` | for example `llama-3.1-8b-instant` | no | The planner's model. |
| `LLM_RESPONSE_FORMAT` | `json_object` | no | Plain JSON mode, for providers without schema support. |
| `LLM_TIMEOUT_SECONDS` | `45` | no | |
| `LLM_MAX_TOKENS` | `1200` | no | |
| `PLANNER_MODE` | `auto` | no | `keyword` always uses the keyword planner. Without a working model the planner falls back to it and the answer says "planner: demo". |
| `LIFEOPS_BACKEND_TOKEN` | the same value as in the web project | yes | With it set, every `/api` call needs it. Without it every `/api` route is open: always set it. |
| `GOOGLE_INTEGRATION_MODE` | `mock` | no | |
| `EXECUTION_BACKEND` | `mock` | no | |

The planner connects to the database for each unit of work and closes the connection again (no pool),
so it can sit behind Supabase's pooler. On a cold start it creates its four tables (`appsettings`,
`task`, `actionproposal`, `planrun`) if they are missing. SQLite stays the local default.

### 3.3 GitHub repository (for `smoke.yml`)

| Name | Kind | Value |
| --- | --- | --- |
| `WEB_URL` | variable | `https://lifeops-ai.vercel.app` |
| `PLANNER_URL` | variable | `https://lifeops-planner.vercel.app` |
| `SUPABASE_URL` | variable | `https://PROJECT_REF.supabase.co` |
| `SUPABASE_PUBLISHABLE_KEY` | variable | the publishable key (not secret; every browser receives it) |
| `LIFEOPS_BACKEND_TOKEN` | secret | the same token as in both Vercel projects |

Set the variables with `gh variable set NAME --body VALUE -R OWNER/REPOSITORY`.

## 4. Limits for a public demo

All visitors share one AI key, so the web app can limit use. Each limit is active only when its setting is
present. With none set (the local default) nothing is limited and no extra queries are made.

| Setting | What it limits | Window |
| --- | --- | --- |
| `AI_CHAT_PER_HOUR` | chat messages one user sends | the last 60 minutes |
| `AI_PLANS_PER_DAY` | week plans (new and refined) one user asks for | the last 24 hours |
| `AI_PLANNER_PER_HOUR` | dashboard "Plan it" requests one user makes | the last 60 minutes |
| `AI_CALLS_PER_DAY` | chat messages, week plans and planner requests of all users together | since midnight UTC |

The rule: a request is allowed while the number of requests already stored in the window is below the
limit, so a limit of 20 allows 20 and refuses the 21st. When a limit is reached the visitor gets a plain
sentence, for example "You have reached this demo's limit of 20 chat messages per hour. Please try again
later." or "This demo's AI allowance for today is used up. It starts again at midnight UTC. Please try
again tomorrow." Nothing is stored for a refused request and the model is not called. The automatic
first-visit briefing is never refused: it gives its rule-based answer instead.

Other protection that does not need code: the 4,000-character message cap, the 1,500-character cap for
plan instructions, Supabase's limit of 30 anonymous sign-ins per hour per IP, no billing on any of the
three free plans, and the clean-up job in section 5.2. A CAPTCHA (for example Cloudflare Turnstile) is not
wired in; it would need a change in `src/routes/login.tsx` and another account.

The sign-in page shows one line when `VITE_HOSTED_DEMO=true`: demo data only, messages go to a hosted AI
provider, do not enter personal information.

## 5. Supabase

### 5.1 Migrations

`supabase db push` applies the 13 files in `supabase/migrations` in order. The last one is new:

- `20261114120000_data_api_grants.sql` gives `authenticated` and `service_role` access to the tables
  (`service_role` alone for `google_oauth_tokens`; `anon` gets nothing). New Supabase projects no longer do
  this by themselves, and without it every query fails with "permission denied for table". Row level
  security still decides which rows a user sees. It does nothing where the roles do not exist, and it is
  harmless on the local stack and on an older project, where it repeats grants that are already there.

### 5.2 Clean-up of old anonymous users (hosted project only)

`supabase/hosted/cleanup_anonymous_users.sql` is not a migration, on purpose: the local stack's database
image has `pg_cron` too, so as a migration the job would also run on every local database. Run the file
once on the hosted project, after the migrations: paste it into the SQL Editor, or run it with `psql` as
the `postgres` role. It enables `pg_cron` if needed, removes a job of the same name if one exists, and
schedules `delete-old-anonymous-users`, a daily job (03:17 UTC) that deletes anonymous users older than
7 days; their rows in the app's tables go with them through the foreign keys. Running it twice leaves one
job. The last statement lists the job.

Checked on a throw-away container of the local image (`supabase/postgres` 17.11) as the `postgres` role:
the file runs twice without error and leaves one job. Not verified on a hosted project: that the `postgres`
role may delete from `auth.users` there (the job's first run is the test; `select * from
cron.job_run_details order by start_time desc limit 5;` shows its result the next day).

No SQL seed is needed: demo calendar events are created per user by the app, and the demo inbox lives in
the code.

### 5.3 Planner role and schema

Run once in the SQL Editor (choose a long password and keep it for `DATABASE_URL`):

```sql
create role lifeops_planner login password 'CHOOSE_A_LONG_PASSWORD';
create schema planner authorization lifeops_planner;
alter role lifeops_planner set search_path = planner;
```

The schema `planner` is not exposed by the Data API, so the planner tables cannot be reached with the
publishable key. For `DATABASE_URL` open Dashboard, Connect, "Session pooler", copy the URI, change the user
to `lifeops_planner.PROJECT_REF`, insert the new password, change the scheme to `postgresql+psycopg://` and
add `?sslmode=require`. Not verified: that the pooler accepts this role and applies its `search_path`. If it
does not, set `DATABASE_SCHEMA=planner` (already in the table above), or use the `postgres` user's pooler URI.

### 5.4 Authentication settings

In Dashboard, Authentication:

- Site URL: `https://lifeops-ai.vercel.app`
- Redirect URLs: `https://lifeops-ai.vercel.app/**` and `http://localhost:5190/**`
- Anonymous sign-ins: on (rate limit 30 per hour per IP)
- Email sign-up: on, with "Confirm email" off. Supabase's built-in email sender delivers only to team
  members, 2 messages per hour, so confirmation cannot work for the public. The consequence is that anyone
  can register any address.
- Google sign-in: off.

## 6. Order of the steps

Steps marked OWNER need an account, a secret or a sign-in that only the owner can provide. The others can be
done with `git`, `gh`, the Supabase CLI and the Vercel CLI once the owner has signed them in.

1. OWNER: create a Groq account (or choose another provider), create an API key, and read the plan's terms and
   limits in the console (requests per minute and per day, tokens per minute, whether a card is needed and
   whether a public app is allowed). If it does not suit, change only `LLM_BASE_URL`, the models and the key.
2. OWNER: create the Vercel account (Hobby plan, "Continue with GitHub") and sign in the CLI with
   `npx vercel@latest login`. Allow the Vercel GitHub App on this repository when it asks.
3. OWNER: create the new Supabase project in Frankfurt and choose its database password (dashboard, or
   `supabase projects create`). Leave "Automatically expose new tables" off: the grants migration handles access.
4. Merge this branch to `main` and let CI pass.
5. `supabase link --project-ref PROJECT_REF`, then `supabase db push --dry-run`, then `supabase db push`. The
   migration list should show 13 applied. Then apply `supabase/hosted/cleanup_anonymous_users.sql` once
   (section 5.2).
6. Push the auth settings of section 5.4 (dashboard, or `supabase config push` from a scratch folder that
   holds only the `[auth]` values; do not push the repository's own `config.toml`, whose Site URL is localhost).
7. OWNER: create the planner role and schema (section 5.3) and build `DATABASE_URL`.
8. Link the planner folder: `cd fastapi-backend`, `npx vercel@latest link --yes --project lifeops-planner`. In the
   project settings set Root Directory to `fastapi-backend` if it is connected to Git, framework FastAPI,
   function region `fra1` (`vercel.json` already asks for it). Add the non-secret settings of section 3.2 with
   `npx vercel@latest env add NAME production`.
9. Link the web project from the repository root with `--project lifeops-ai` and add the non-secret settings of
   section 3.1 the same way. Set the function region to `fra1` in Project Settings, Functions (the web project has no
   `vercel.json`).
10. OWNER: the secrets, without putting them in chat or in a file:
    - `SUPABASE_SECRET_KEY`: copy it from the dashboard (API keys), then
      `npx vercel@latest env add SUPABASE_SECRET_KEY production --sensitive` in the repository root.
    - `LLM_API_KEY`: the same command in the repository root and again in `fastapi-backend`.
    - `DATABASE_URL`: `npx vercel@latest env add DATABASE_URL production --sensitive` in `fastapi-backend`.
    - `LIFEOPS_BACKEND_TOKEN`: one random value in three places. In PowerShell:
      ```powershell
      $t = node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64url'))"
      $t | npx vercel@latest env add LIFEOPS_BACKEND_TOKEN production --sensitive
      $t | npx vercel@latest env add LIFEOPS_BACKEND_TOKEN production --sensitive --cwd fastapi-backend
      $t | gh secret set LIFEOPS_BACKEND_TOKEN -R OWNER/REPOSITORY
      Remove-Variable t
      ```
11. Deploy the planner first: `npx vercel@latest deploy --prod --cwd fastapi-backend`. Open its address: `/` should
    answer `status: ok`, `planner: llm`, `auth_required: true`. Fix `LIFEOPS_BACKEND_URL` if the address differs.
    Then deploy the web app: `npx vercel@latest deploy --prod` in the repository root. If the web app's address
    differs from `lifeops-ai.vercel.app`, repeat step 6 with the real one and update `FRONTEND_ORIGIN`.
12. Set the four repository variables of section 3.3 and run the smoke workflow once:
    `gh workflow run smoke.yml`, then `gh run watch`.
13. Check the live app (section 7).

## 7. Checks after the first deploy

- `curl -sI https://lifeops-ai.vercel.app/login` answers 200. The planner's `/` answers `status ok`,
  `planner llm`. `/api/dashboard` on the planner without the token answers 401.
- In a private window, "Try the live demo" signs in, `/app` loads, and the first-visit briefing arrives within
  seconds and does not say "Ranked by simple rules".
- Chat: "Block 3-5 pm tomorrow for a gym push workout." gives a card, and **Save** puts it in the calendar.
- Week plan: **Create plan** gives a plan within seconds; a reload during drafting shows "Drafting your week
  plan" and then the plan.
- Dashboard: "Plan it" with "Block Thursday 2-4 pm for deep work and draft an email to Sam" gives mode
  service and planner llm. **Approve**, then **Run**, writes the block. After about 15 minutes without use the
  dashboard still loads its planner section.
- The planner's data survives a redeploy of the planner (earlier actions are still listed).
- A second private window with another demo user sees none of the first user's chats, plans or planner rows.
- The Vercel runtime logs of the web project show lines like `[llm] Groq MODEL: N prompt + M completion tokens in
  X s`, and no "permission denied for table" or "Missing Supabase environment variable".
- With `AI_CHAT_PER_HOUR=20`, the 21st quick message from one demo user gets the limit sentence and no model call.

## 8. The daily smoke check

`.github/workflows/smoke.yml` runs every day at 05:17 UTC and on request. It checks that the sign-in page
loads and names MONDAY, that Supabase's auth health answers, that the planner reports `status ok` and
`planner llm`, and (with the token secret) that the planner can read its database through
`/api/dashboard`. That query is the daily activity that keeps a free Supabase project from being paused.
On Mondays and on manual runs it also asks the planner for one plan, which is one real model call.

While the four variables are not set, the run ends with a notice and counts as passed. A failing run sends
the usual GitHub email. The last step switches the workflow on again through the API, because GitHub turns
off scheduled workflows in a public repository after 60 days without repository activity; that step needs the
permission `actions: write`, which the workflow declares. Not verified: that this call resets the 60-day clock.
If GitHub emails that the workflow was turned off anyway, push a commit or run
`gh workflow enable smoke.yml`. A project paused by Supabase is restored in the dashboard ("Restore project").

## 9. Free-plan limits to know

- Vercel Hobby: functions run up to 300 s, which covers a chat turn, a week plan and "Plan it" with a model that
  answers in seconds. Monthly limits (active CPU, invocations, memory) pause features for up to 30 days when
  exceeded. Waiting for the model counts as I/O, not CPU. Not verified: whether Vercel keeps a function
  running after the browser disconnects; a request cut off that way stays "running" until the stale window
  (`LLM_TIMEOUT_MS` plus 2 minutes) has passed and then shows "did not finish".
- Supabase free: 500 MB database, pauses after 7 days without database activity.
- The provider's own limits apply per organisation and per model; the daily cap above should stay below them.

## 10. Common errors

- **"permission denied for table ..."**: the grants migration was not applied. Run `supabase db push`.
- **"Missing Supabase environment variable"**: one of the five Supabase settings in section 3.1 is missing.
  `VITE_` settings are read at build time, so redeploy after changing them.
- **The dashboard says the planner is stopped**: check `LIFEOPS_BACKEND_URL` and that the token is the same in
  both projects. After an idle period the first call can be slow; raise `LIFEOPS_BACKEND_DASHBOARD_TIMEOUT_MS`.
- **"The planner service rejected MONDAY's token"**: `LIFEOPS_BACKEND_TOKEN` differs between the projects.
- **"... rate limit reached"**: the provider's limit. The fallback model is tried first; the caps in section 4
  keep the demo below the limit.
- **A planner action is "not found" at Approve**: the planner is still on SQLite (no `DATABASE_URL`), so its data
  disappeared with an instance.
- **Local build writes `dist/`, not `.vercel/output`**: set `NITRO_PRESET=vercel`; Vercel does it by itself.
- **Lockfile or install errors**: use Node 22 and run `npm ci`. The `overrides` entry in `package.json` is
  needed for `nitro`; do not remove it.
