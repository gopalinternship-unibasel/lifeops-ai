# Deploying MONDAY (LifeOps AI) to Vercel

This describes the hosted setup. It was deployed on 17 Nov 2026; section 0 says what is live and
what differed from the plan in the sections after it. Items in the later sections that are still
marked "Not verified" or "not yet run" were written before the deployment; section 0 is the newer
statement where the two differ.

## 0. What is live (17 Nov 2026)

| Part                 | Address                               | State                                                                                                                                                                                                                                                                            |
| -------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web app              | <https://lifeops-ai-sigma.vercel.app> | Vercel project `lifeops-ai`, region fra1 (from the root `vercel.json`). The plain name `lifeops-ai.vercel.app` belongs to someone else's project.                                                                                                                                |
| Planner              | <https://lifeops-planner.vercel.app>  | Vercel project `lifeops-planner`, framework preset FastAPI, region fra1. `/api/*` answers 401 without the token.                                                                                                                                                                 |
| Database and sign-in | Supabase project in Frankfurt         | 13 migrations, the clean-up job, the planner role and schema. Site URL and redirect URLs point at the web address above.                                                                                                                                                         |
| AI                   | Cloudflare Workers AI                 | Web app: `@cf/zai-org/glm-4.7-flash`, fallback `@cf/google/gemma-4-26b-a4b-it`, `LLM_STRUCTURED_OUTPUT=tools_required`. Planner: `@cf/google/gemma-4-26b-a4b-it` with `LLM_RESPONSE_FORMAT=none`. Both send `LLM_EXTRA_BODY={"chat_template_kwargs":{"enable_thinking":false}}`. |

Checked on the live site that day, as an anonymous demo visitor in a browser: the first-visit
briefing (it fell back to the list built from the data, with its notice), a chat request that
produced a calendar card and saved it, a week plan in under 30 seconds, and "Plan it" on the
dashboard through the planner service (planned by the AI model, approve and run wrote the block to
the calendar). The smoke workflow passes, including its real planner call.

What the deployment taught, beyond the plan below:

- **Thinking must be off.** Both Cloudflare models think before they answer. A short structured
  answer took 3 to 6 seconds with thinking and about 1.2 seconds without. `reasoning_effort` did not
  shorten it; the request field `chat_template_kwargs: {"enable_thinking": false}` did, hence
  `LLM_EXTRA_BODY`.
- **Plain JSON needs the right model.** Without tools, glm-4.7-flash spent its whole token budget
  thinking and returned no text, so the planner (which asks for plain JSON) uses gemma-4.
- **Tool calls:** both models returned a correct call with `tool_choice: "required"`. With a named
  function glm-4.7-flash answered in its own text format, so `tools_required` is the mode to use.
- **The Vercel CLI does not read `.gitignore`.** The root `.vercelignore` names what stays out of
  the upload, with a leading slash on every folder: without it `supabase/` also excluded
  `src/integrations/supabase/` and the build failed.
- **TanStack Start had to be upgraded** to 1.168.61: Vercel refuses to deploy the earlier version
  because of a cross-site scripting advisory.
- **Linking:** `vercel link` adds `.env*` to `.gitignore` and writes `.env.local`; the first was
  undone, the planner folder got its own small `.gitignore`.
- The planner's startup hook does create its tables on Vercel, and the planner role does connect
  through the Supabase session pooler with its own schema.

## 1. What runs where

| Part                            | Where                                                                     | Notes                                                                                                                                                                                                             |
| ------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web app (TanStack Start, React) | Vercel project `lifeops-ai`, root directory = repository root             | One function for server rendering and server functions, static files from the CDN. Node 22.x.                                                                                                                     |
| Planner (FastAPI)               | Vercel project `lifeops-planner`, root directory = `fastapi-backend`      | Python 3.13 function, entry point `app/main.py` (`app`). Only the web app's server calls it.                                                                                                                      |
| Database and sign-in            | A new Supabase project (free plan), region Frankfurt                      | The 13 migrations (12 older ones plus the new grants migration), then the one-off clean-up file `supabase/hosted/cleanup_anonymous_users.sql`. The planner uses the same project through its own role and schema. |
| AI model                        | Cloudflare Workers AI (free allowance), through its OpenAI-compatible API | Chosen by the owner on 14 Nov 2026. In use since 17 Nov 2026; see section 0 and section 2.                                                                                                                        |
| Monitoring                      | GitHub Actions workflow `smoke.yml`                                       | Once a day.                                                                                                                                                                                                       |

The web app is a full-stack app. It is not a static site: do not set an Output Directory and do not add
a catch-all rewrite. The Lovable wrapper that wraps `vite.config.ts` does not make the build ready for
Vercel by itself. The `nitro` package does, and `vite.config.ts` turns it on only when a target is named:

- `npm run build` with no target: the plain TanStack Start output in `dist/`, as before (used locally and
  in CI). `nitro` is not used.
- `NITRO_PRESET=vercel npm run build`: writes `.vercel/output` (Vercel's Build Output API). On Vercel the
  variable `VERCEL=1` is set by Vercel itself and selects the same preset, so `NITRO_PRESET` is optional
  there. `nitro` is pinned to an exact version in `package.json`; an `overrides` entry lets the Lovable
  wrapper accept it, because the wrapper's version range does not name release candidates.
- `npm run build:pages`: the GitHub Pages edition (static files plus a bundle for a Supabase Edge
  Function). It does not change the two builds above; see `PAGES_DEPLOYMENT.md`.

`src/start.ts` sets TanStack Start's CSRF check explicitly (server-function calls must come from the
page's own origin). This is the check Start applies by itself when an app has no `src/start.ts`. The
file also installs, for this deployment as for the GitHub Pages edition, the handling of errors
TanStack Start does not answer well by itself (`src/lib/server-fn-errors.ts`): in the browser, an error
answer in JSON without TanStack's own header (a platform or gateway error) becomes a short sentence
instead of being taken for the function's result, and Vercel's own plain-text error pages (for example
`FUNCTION_INVOCATION_FAILED` for a crashed function) become a sentence too, instead of reaching a message
as they are; on the server, a call to a server function this
deployment does not have (an open tab from before a deploy that renamed one) gets 404 with "MONDAY may
have been updated since this page was opened. Reload the page and try again.", and an unreadable
payload gets 400, instead of 500.

## 2. The AI provider

The code is provider-neutral: three settings choose it (`LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY`), in
both Vercel projects. The hosted demo uses **Cloudflare Workers AI**. The facts below were read on
Cloudflare's pages on 14 Nov 2026; none of them has been run against the API yet.

- Address: `LLM_BASE_URL=https://api.cloudflare.com/client/v4/accounts/ACCOUNT_ID/ai/v1` (OpenAI-compatible
  `chat/completions`). `ACCOUNT_ID` is the Cloudflare Account ID (dashboard, Workers AI, "Use REST API").
- Key: `LLM_API_KEY` is a Workers AI API token, created on the same page, with the permissions Workers AI
  Read and Workers AI Edit.
- Models: `@cf/zai-org/glm-4.7-flash` (main) and `@cf/google/gemma-4-26b-a4b-it` (fallback).
- Free allowance: 10,000 neurons a day for the whole Cloudflare account, no card needed. Above it nothing
  runs until the next day. The same account also serves a second demo (ai-scientist), so both share the
  allowance; the caps in section 4 are sized for that. Cloudflare states that customer content is not used
  for training. Not verified: which HTTP status Workers AI answers when the allowance is used up.
- Price in neurons: glm-4.7-flash 5,500 per million input tokens and 36,400 per million output tokens;
  gemma-4-26b-a4b-it 9,091 and 27,273.
- Structured answers, web app: Workers AI accepts `tools` with `tool_choice` `none`, `auto` or `required`;
  naming one function in `tool_choice` is not documented. `LLM_STRUCTURED_OUTPUT=tools_required` therefore
  sends only the function a call needs, with `tool_choice: "required"`. Not verified: that both models
  answer such a call with a function call; if the first live chat turn returns no card, look at the
  runtime log.
- Structured answers, planner: Cloudflare lists JSON mode (`response_format` `json_object` or `json_schema`)
  only for older models, and not for streaming. The planner therefore uses `LLM_RESPONSE_FORMAT=none`: no
  `response_format` is sent, the prompt asks for JSON, and the planner takes the first JSON object from the
  answer's text (code fences are stripped). If it cannot read a plan it falls back to the keyword planner
  and says so.
- A rate-limit answer (HTTP 429) from the main model makes the app try `LLM_FALLBACK_MODEL`. With Workers AI
  both models draw on the same daily allowance, so the fallback cannot help once the allowance is used up.
- Messages name the provider from its host ("Cloudflare Workers AI", and also Groq, Cerebras, OpenRouter,
  Together AI, Mistral, OpenAI, Hugging Face, Google Gemini) and say "the AI provider" for any other host.
- Alternative: Groq (`LLM_BASE_URL=https://api.groq.com/openai/v1`, `LLM_STRUCTURED_OUTPUT=tools`, planner
  `LLM_RESPONSE_FORMAT=json_object`). Its free-plan terms were not checked. Switching changes only
  `LLM_BASE_URL`, the models, the key and the two structured-output settings.
- Do not use a free Google Gemini key for a public demo. Google's terms allow only paid services for apps
  offered to users in the EEA, and the clause also names Switzerland and the UK; the free tier also lets
  reviewers read inputs.

## 3. Settings

### 3.1 Web project `lifeops-ai` (Vercel, Production)

Settings that begin with `VITE_` are read when the app is built and end up in the browser. Everything else
is read by the server at run time. Change a setting, then redeploy.

| Setting                                | Value                                                            | Secret | Meaning                                                                                                                                  |
| -------------------------------------- | ---------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `VITE_SUPABASE_URL`                    | `https://PROJECT_REF.supabase.co`                                | no     | Supabase project URL (browser).                                                                                                          |
| `VITE_SUPABASE_PUBLISHABLE_KEY`        | `sb_publishable_...`                                             | no     | Publishable key (browser).                                                                                                               |
| `SUPABASE_URL`                         | same as `VITE_SUPABASE_URL`                                      | no     | Same URL for the server.                                                                                                                 |
| `SUPABASE_PUBLISHABLE_KEY`             | same as `VITE_SUPABASE_PUBLISHABLE_KEY`                          | no     | Same key for the server.                                                                                                                 |
| `SUPABASE_SECRET_KEY`                  | `sb_secret_...`                                                  | yes    | Server-only key. Never put it in a `VITE_` setting.                                                                                      |
| `VITE_ENABLE_ANONYMOUS_DEMO`           | `true`                                                           | no     | Shows "Try the live demo" (anonymous sign-in).                                                                                           |
| `VITE_ENABLE_GOOGLE_SIGNIN`            | `false`                                                          | no     | Hides "Continue with Google".                                                                                                            |
| `VITE_HOSTED_DEMO`                     | `true`                                                           | no     | Shows the one-line demo notice on the sign-in page. Leave unset locally.                                                                 |
| `LLM_BASE_URL`                         | `https://api.cloudflare.com/client/v4/accounts/ACCOUNT_ID/ai/v1` | no     | Workers AI's OpenAI-compatible URL with the Cloudflare Account ID. Kept private; without it the hosted site says AI is not set up.       |
| `LLM_API_KEY`                          | the Workers AI API token                                         | yes    |                                                                                                                                          |
| `LLM_MODEL`                            | `@cf/zai-org/glm-4.7-flash`                                      | no     | Main model for chat and plans.                                                                                                           |
| `LLM_FALLBACK_MODEL`                   | `@cf/google/gemma-4-26b-a4b-it`                                  | no     | Tried after 401, 403, 404, 429 or 503 from the main model.                                                                               |
| `LLM_STRUCTURED_OUTPUT`                | `tools_required`                                                 | no     | `tools`, `tools_required` or `json_schema` (see section 2). Any other value means `tools`.                                               |
| `LLM_TIMEOUT_MS`                       | `60000`                                                          | no     | Time allowed for one model call. A chat turn can take up to twice this plus 2 minutes (main model, then fallback).                       |
| `LLM_MAX_TOKENS`                       | `1200`                                                           | no     | Longest chat answer.                                                                                                                     |
| `LLM_MAX_TOKENS_PLAN`                  | `2400`                                                           | no     | Longest week plan.                                                                                                                       |
| `LIFEOPS_BACKEND_URL`                  | `https://lifeops-planner.vercel.app`                             | no     | The planner's address. `off` turns the planner off and the dashboard uses the in-app assistant.                                          |
| `LIFEOPS_BACKEND_TOKEN`                | a random value                                                   | yes    | Shared with the planner (same value in both projects).                                                                                   |
| `LIFEOPS_BACKEND_TIMEOUT_MS`           | `60000`                                                          | no     | Time allowed for "Plan it". Default: `LLM_TIMEOUT_MS` plus 30 s.                                                                         |
| `LIFEOPS_BACKEND_DASHBOARD_TIMEOUT_MS` | `10000`                                                          | no     | Time allowed for the planner's quick calls (dashboard read, approve, reject). Default 10000; a planner that was idle needs a cold start. |
| `AI_CHAT_PER_HOUR`                     | `20`                                                             | no     | See section 4. Unset = no limit. Whole numbers only.                                                                                     |
| `AI_PLANS_PER_DAY`                     | `5`                                                              | no     | See section 4.                                                                                                                           |
| `AI_PLANNER_PER_HOUR`                  | `6`                                                              | no     | See section 4.                                                                                                                           |
| `AI_CALLS_PER_DAY`                     | `150`                                                            | no     | See section 4. Sized for the shared free allowance of 10,000 neurons a day.                                                              |
| `NITRO_PRESET`                         | `vercel`                                                         | no     | Build target. Optional on Vercel, which sets `VERCEL=1`.                                                                                 |
| `LIFEOPS_MAX_REQUEST_MS`               | (unset)                                                          | no     | Longest time the host lets a request run. Unset on Vercel: the app uses Hobby's 300 s. The Pages edition sets 160000.                    |

`LLM_BASE_URL` cannot be used without the API token, but it is kept private: the Pages edition stores it as a
function secret, and the hosted site's messages to visitors leave it out. Without it the hosted site answers
that the AI assistant is not set up; it never tries a local model. `LIFEOPS_MAX_REQUEST_MS` is the time after
which an unfinished request shows as interrupted; set it only on a Vercel plan whose limit is not Hobby's 300 s.

Leave these unset: `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_STATE_SECRET`,
`GOOGLE_OAUTH_REDIRECT_URI` (Gmail and Calendar stay off; the demo inbox and calendar are used and the
Connectors page says Google is not configured), `HUGGINGFACE_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`,
`LLM_MODEL_CHAT`, `LLM_MODEL_PLAN`, `LLM_MODEL_DRAFT` (they inherit `LLM_MODEL`) and `LLM_TEMPERATURE`.

### 3.2 Planner project `lifeops-planner` (Vercel, Production)

| Setting                        | Value                                                                                                 | Secret | Meaning                                                                                                                                                              |
| ------------------------------ | ----------------------------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ENV`                          | `production`                                                                                          | no     | Turns off SQL logging and `/docs`; also the default when `ENV` is unset.                                                                                             |
| `DATABASE_URL`                 | `postgresql+psycopg://lifeops_planner.PROJECT_REF:PASSWORD@POOLER_HOST:5432/postgres?sslmode=require` | yes    | Supabase session pooler, planner role. `postgres://` and `postgresql://` are also accepted.                                                                          |
| `DATABASE_SCHEMA`              | `planner`                                                                                             | no     | Optional. Every connection puts this schema first on its `search_path`. The role already has the same default, so this is a second safeguard. The schema must exist. |
| `FRONTEND_ORIGIN`              | `https://lifeops-ai-sigma.vercel.app`                                                                 | no     | For CORS. Only the web app's server calls the planner, so CORS is not used in practice.                                                                              |
| `LLM_BASE_URL`                 | same as the web app                                                                                   | no     |                                                                                                                                                                      |
| `LLM_API_KEY`                  | same key                                                                                              | yes    |                                                                                                                                                                      |
| `LLM_MODEL`                    | `@cf/google/gemma-4-26b-a4b-it`                                                                       | no     | The planner's model.                                                                                                                                                 |
| `LLM_RESPONSE_FORMAT`          | `none`                                                                                                | no     | No `response_format` is sent; the plan is read from the first JSON object in the answer (section 2). Other values: `json_schema` (default), `json_object`.           |
| `LLM_TIMEOUT_SECONDS`          | `45`                                                                                                  | no     |                                                                                                                                                                      |
| `LLM_MAX_TOKENS`               | `1200`                                                                                                | no     |                                                                                                                                                                      |
| `PLANNER_MODE`                 | `auto`                                                                                                | no     | `keyword` always uses the keyword planner. Without a working model the planner falls back to it and the answer says "planner: demo".                                 |
| `LIFEOPS_BACKEND_TOKEN`        | the same value as in the web project                                                                  | yes    | With it set, every `/api` call needs it. Without it every `/api` route is open: always set it.                                                                       |
| `LIFEOPS_BACKEND_EXTRA_TOKENS` | further accepted tokens, comma separated                                                              | yes    | Optional. The GitHub Pages edition's Edge Function uses its own token (see `PAGES_DEPLOYMENT.md`), so either can be replaced without the other.                      |
| `GOOGLE_INTEGRATION_MODE`      | `mock`                                                                                                | no     |                                                                                                                                                                      |
| `EXECUTION_BACKEND`            | `mock`                                                                                                | no     |                                                                                                                                                                      |

The planner connects to the database for each unit of work and closes the connection again (no pool),
so it can sit behind Supabase's pooler. On a cold start it creates its four tables (`appsettings`,
`task`, `actionproposal`, `planrun`) if they are missing. SQLite stays the local default.

### 3.3 GitHub repository (for `smoke.yml`)

| Name                       | Kind     | Value                                                       |
| -------------------------- | -------- | ----------------------------------------------------------- |
| `WEB_URL`                  | variable | `https://lifeops-ai-sigma.vercel.app`                       |
| `PLANNER_URL`              | variable | `https://lifeops-planner.vercel.app`                        |
| `SUPABASE_URL`             | variable | `https://PROJECT_REF.supabase.co`                           |
| `SUPABASE_PUBLISHABLE_KEY` | variable | the publishable key (not secret; every browser receives it) |
| `LIFEOPS_BACKEND_TOKEN`    | secret   | the same token as in both Vercel projects                   |

Set the variables with `gh variable set NAME --body VALUE -R OWNER/REPOSITORY`.

## 4. Limits for a public demo

All visitors share one AI key, so the web app can limit use. Each limit is active only when its setting is
present. With none set (the local default) nothing is limited and no extra queries are made.

| Setting               | What it limits                                                                      | Window              |
| --------------------- | ----------------------------------------------------------------------------------- | ------------------- |
| `AI_CHAT_PER_HOUR`    | chat messages and email reply drafts one user asks for                              | the last 60 minutes |
| `AI_PLANS_PER_DAY`    | week plans (new and refined) one user asks for                                      | the last 24 hours   |
| `AI_PLANNER_PER_HOUR` | dashboard "Plan it" requests one user makes                                         | the last 60 minutes |
| `AI_CALLS_PER_DAY`    | chat messages, reply drafts, week plans and planner requests of all users together | since midnight UTC  |

The rule: a request is allowed while the number of uses already recorded in the window is below the
limit, so a limit of 20 allows 20 and refuses the 21st. Each allowed request that calls the model
records one use in a ledger table in the database that only the server can write (`public.ai_usage`);
the check and the record are one database call, so requests sent at the same moment cannot pass a cap
together. Work that makes no model call (such as the rule-based briefing) records nothing, and the caps
no longer depend on how many chat messages, plans or planner requests are stored. When a limit is
reached the visitor gets a plain sentence, for example "You have reached this demo's limit of 20 chat
messages per hour. Please try again later." or "This demo's AI allowance for today is used up. It starts
again at midnight UTC. Please try again tomorrow." A refused request records no use and the model is not
called. "Plan it" checks the planner limits and records one planner use before it stores its planner
request; when the planner service cannot be reached, the request falls back to a chat turn, which is
checked against the chat and daily limits on its own but records no use of its own, and if one of them
refuses it, the planner request stays stored as failed with the limit sentence. The automatic briefing of a first visit is never refused: it gives its rule-based
answer instead. A later briefing over the limit is refused like any other message.

The values for the hosted demo (`AI_CHAT_PER_HOUR=20`, `AI_PLANS_PER_DAY=5`, `AI_PLANNER_PER_HOUR=6`,
`AI_CALLS_PER_DAY=150`) are sized for Cloudflare's free 10,000 neurons a day, which the ai-scientist demo
shares: a chat call of about 2,500 input and 200 output tokens costs about 21 neurons on glm-4.7-flash
(2,500 x 5,500 / 1,000,000 + 200 x 36,400 / 1,000,000), and a week plan of about 3,000 input and 2,400
output tokens about 105, so 150 chat calls are about 3,150 neurons. The caps do not guarantee the
allowance: 150 week plans would be about 15,750 neurons, a call to the fallback model counts too, and the
token counts are estimates, not measured on Workers AI. Watch the usage in the Cloudflare dashboard during
the first days.

Before the ledger, the caps counted stored rows and then stored the new one in a separate step, so
requests sent at the same moment could all pass a cap, as many as were sent at once. A second running
week plan for the same week, or a second running "Plan it" for the same user, is also refused by the
database itself ("still being drafted" / "already running").

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
grant lifeops_planner to postgres;
create schema planner authorization lifeops_planner;
alter role lifeops_planner set search_path = planner;
```

The second line is needed: on Supabase's Postgres 17 the `postgres` role is not a superuser, and without
that grant `create schema ... authorization lifeops_planner` fails with `must be able to SET ROLE
"lifeops_planner"`. Checked on a throw-away container of `supabase/postgres` 17.11 as the `postgres` role:
the three lines without the grant fail with that error and create no schema; with it the schema is
created, `lifeops_planner` signs in with `current_schema()` = `planner` and can create a table there, and
`anon`, `authenticated` and `service_role` have no `USAGE` on the schema. Not yet run on the hosted project.

The schema `planner` is not exposed by the Data API, so the planner tables cannot be reached with the
publishable key. For `DATABASE_URL` open Dashboard, Connect, "Session pooler", copy the URI, change the user
to `lifeops_planner.PROJECT_REF`, insert the new password, change the scheme to `postgresql+psycopg://` and
add `?sslmode=require`. Not verified: that the pooler accepts this role and applies its `search_path`. If it
does not, set `DATABASE_SCHEMA=planner` (already in the table above), or use the `postgres` user's pooler URI.

### 5.4 Authentication settings

In Dashboard, Authentication:

- Site URL: `https://lifeops-ai-sigma.vercel.app`
- Redirect URLs: `https://lifeops-ai-sigma.vercel.app/**` and `http://localhost:5190/**`
- Anonymous sign-ins: on (rate limit 30 per hour per IP)
- Email sign-up: on, with "Confirm email" off. Supabase's built-in email sender delivers only to team
  members, 2 messages per hour, so confirmation cannot work for the public. The consequence is that anyone
  can register any address.
- Google sign-in: off.

## 6. Order of the steps

Steps marked OWNER need an account, a secret or a sign-in that only the owner can provide. The others can be
done with `git`, `gh`, the Supabase CLI and the Vercel CLI once the owner has signed them in.

1. OWNER: in the Cloudflare account that already serves the ai-scientist demo (or a new free one), open
   Workers AI, "Use REST API", copy the **Account ID** (it goes into `LLM_BASE_URL`) and create a **Workers AI
   API token** with the permissions Workers AI Read and Workers AI Edit (it is `LLM_API_KEY`). Keep the token
   out of chat and files; it is shown once.
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
   section 3.1 the same way. The function region `fra1` comes from the root `vercel.json`; check it under Project
   Settings, Functions.
10. OWNER: the secrets, without putting them in chat or in a file:
    - `SUPABASE_SECRET_KEY`: copy it from the dashboard (API keys), then
      `npx vercel@latest env add SUPABASE_SECRET_KEY production --sensitive` in the repository root.
    - `LLM_API_KEY` (the Workers AI API token): the same command in the repository root and again in
      `fastapi-backend`.
    - `DATABASE_URL`: `npx vercel@latest env add DATABASE_URL production --sensitive` in `fastapi-backend`.
    - `LIFEOPS_BACKEND_TOKEN`: one random value in three places. Do not pipe it (`$t | ...`): Windows
      PowerShell 5.1 adds a line ending to a string it pipes into a program, so the copies could differ.
      Pass it as an argument instead. In PowerShell, in the repository root:
      ```powershell
      $t = node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64url'))"
      npx vercel@latest env add LIFEOPS_BACKEND_TOKEN --environment production --sensitive --value $t --yes
      npx vercel@latest env add LIFEOPS_BACKEND_TOKEN --environment production --sensitive --value $t --yes --cwd fastapi-backend
      gh secret set LIFEOPS_BACKEND_TOKEN --body $t -R OWNER/REPOSITORY
      Remove-Variable t
      ```
      The token is base64url (letters, digits, `-` and `_`), so PowerShell passes it unchanged. `--value`,
      `--environment`, `--yes` and the global `--cwd` are listed by `npx vercel@latest env add --help` and
      `npx vercel@latest --help` (Vercel CLI 65.16.0, 14 Nov 2026); `--body` by `gh secret set --help`. Not yet
      run. The value is visible in the process list while each command runs, which is acceptable on the
      owner's own PC. Check afterwards that the copies match: the planner's `/api/dashboard` answers 401
      without the token, and the web app's dashboard loads its planner section (a wrong copy gives the badge
      "Planner service unavailable — in-app assistant" with "The planner service is not set up correctly for
      this site.", and the runtime log shows `planner GET /api/dashboard: HTTP 401`); the smoke workflow's
      `/api/dashboard` step checks the GitHub copy.
11. Deploy the planner first: `npx vercel@latest deploy --prod --cwd fastapi-backend`. Open its address: `/` should
    answer `status: ok`, `planner: llm`, `auth_required: true`. Fix `LIFEOPS_BACKEND_URL` if the address differs.
    Then deploy the web app: `npx vercel@latest deploy --prod` in the repository root. If the web app's address
    differs from `lifeops-ai-sigma.vercel.app`, repeat step 6 with the real one and update `FRONTEND_ORIGIN`.
12. Set the four repository variables of section 3.3 and run the smoke workflow once:
    `gh workflow run smoke.yml`, then `gh run watch`.
13. Check the live app (section 7).

## 7. Checks after the first deploy

- `curl -sI https://lifeops-ai-sigma.vercel.app/login` answers 200. The planner's `/` answers `status ok`,
  `planner llm`. `/api/dashboard` on the planner without the token answers 401.
- In a private window, "Try the live demo" signs in, `/app` loads, and the first-visit briefing arrives (about
  27 s in a November 2026 measurement: the model writes the whole briefing) and does not say "Ranked by simple
  rules".
- Chat: "Block 3-5 pm tomorrow for a gym push workout." gives a card (2 to 6 s), and **Save** puts it in the
  calendar.
- Week plan: **Create plan** gives a plan (about 30 s in the same measurement); a reload during drafting shows
  "Drafting your week plan" and then the plan.
- Dashboard: "Plan it" with "Block Thursday 2-4 pm for deep work and draft an email to Sam" gives mode
  service and planner llm. **Approve**, then **Run**, writes the block. After about 15 minutes without use the
  dashboard still loads its planner section.
- The planner's data survives a redeploy of the planner (earlier actions are still listed).
- A second private window with another demo user sees none of the first user's chats, plans or planner rows.
- The Vercel runtime logs of the web project show lines like `[llm] Cloudflare Workers AI @cf/zai-org/glm-4.7-flash: N
prompt + M completion tokens in X s`, and no "permission denied for table" or "Missing Supabase environment variable".
- With `AI_CHAT_PER_HOUR=20`, the 21st quick message from one demo user gets the limit sentence and no model call.

## 8. The daily smoke check

`.github/workflows/smoke.yml` runs every day at 05:17 UTC and on request. It checks that the sign-in page
loads and names MONDAY, that Supabase's auth health answers, that the planner reports `status ok` and
`planner llm`, and (with the token secret) that the planner can read its database through
`/api/dashboard`. That query is the daily activity that keeps a free Supabase project from being paused.
On Mondays and on manual runs it also asks the planner for one plan, which is one real model call; it sends
the current time in Zurich with the zone, as the web app does. With the repository variable `PAGES_URL` set it
also checks the GitHub Pages edition, and fails while that edition's function cannot reach the planner or has
no AI provider set up (`PAGES_DEPLOYMENT.md`, "Checks").

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
  running after the browser disconnects; a request cut off that way stays "running" until its stale window
  has passed and then shows "did not finish". The windows: a chat turn or a week plan, twice `LLM_TIMEOUT_MS`
  (main model, then fallback) plus 2 minutes, 240 s with the values above; "Plan it",
  `LIFEOPS_BACKEND_TIMEOUT_MS` plus a chat turn's window plus 1 minute, 360 s, which the app caps at Vercel
  Hobby's 300 s (`LIFEOPS_MAX_REQUEST_MS` sets another cap).
- Supabase free: 500 MB database, pauses after 7 days without database activity.
- Cloudflare Workers AI free: 10,000 neurons a day for the whole account (shared with the ai-scientist demo),
  no card; above it nothing runs until the next day. The caps in section 4 are sized for it (not yet run).

## 10. Common errors

- **"permission denied for table ..."**: the grants migration was not applied. Run `supabase db push`.
- **"Missing Supabase environment variable"**: one of the five Supabase settings in section 3.1 is missing.
  `VITE_` settings are read at build time, so redeploy after changing them.
- **The dashboard shows "Planner service offline — in-app assistant"** ("The planner service could not be
  reached."): check `LIFEOPS_BACKEND_URL` and that the planner is up. **"Planner service unavailable — in-app
  assistant"** with "The planner service did not answer within 10 s.": after an idle period the first call can
  be slow; raise `LIFEOPS_BACKEND_DASHBOARD_TIMEOUT_MS`.
- **"Planner service unavailable — in-app assistant" with "The planner service is not set up correctly for this
  site."**: the planner refused the token (HTTP 401 in the runtime log): `LIFEOPS_BACKEND_TOKEN` is missing or
  differs between the projects.
- **"The AI assistant is not set up on this site yet, so this request could not be answered."** and the dashboard
  badge "AI not set up on this site": `LLM_BASE_URL` is not set (the hosted site never falls back to a local
  model). **"The AI assistant is not set up correctly on this site right now."**: Cloudflare refused
  `LLM_API_KEY` or the model in `LLM_MODEL` / `LLM_FALLBACK_MODEL`; the runtime log names which.
- **"MONDAY may have been updated since this page was opened. Reload the page and try again."**: a tab opened
  before a deploy called a server function that was renamed, moved or removed since. Reloading fixes it.
- **"Something went wrong on the server. Please try again."**: an error answer the page cannot read by itself,
  such as Vercel's `FUNCTION_INVOCATION_FAILED` (the function crashed; the runtime log has the stack). The
  browser console has a line `[lifeops] A server function answered HTTP <status>: ...` with what was sent.
- **"This request is too large for the server. Please shorten what you entered and try again."**: Vercel refused
  the request body (413, `FUNCTION_PAYLOAD_TOO_LARGE`) or its address (414, `URI_TOO_LONG`) as too large.
- **"... rate limit reached"** or other refusals from Cloudflare Workers AI: a rate limit, or the account's
  10,000 daily neurons are used up (possibly by the ai-scientist demo, which shares them). The fallback model
  is tried after a 429, but it draws on the same allowance. Look at the usage in the Cloudflare dashboard;
  lower the caps in section 4 if the allowance runs out early. Which status Workers AI sends for a used-up
  allowance is not verified.
- **A planner action is "not found" at Approve**: the planner is still on SQLite (no `DATABASE_URL`), so its data
  disappeared with an instance.
- **Local build writes `dist/`, not `.vercel/output`**: set `NITRO_PRESET=vercel`; Vercel does it by itself.
- **Lockfile or install errors**: use Node 22 and run `npm ci`. The `overrides` entry in `package.json` is
  needed for `nitro`; do not remove it.
