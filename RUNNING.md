# Running LifeOps AI (MONDAY) on this PC

MONDAY is the July 2026 TanStack Start rework of the Bobathon LifeOps AI project. Locally it runs as:

| Part | URL / port | Notes |
| --- | --- | --- |
| Web app (TanStack Start, React) | http://localhost:5190 | Use `localhost`, not `127.0.0.1` (Vite listens on `localhost`). |
| FastAPI planner service | http://127.0.0.1:8010 (docs: `/docs`) | `fastapi-backend/`, SQLite file `fastapi-backend/lifeops.db` |
| Supabase API (auth + Postgres REST) | http://127.0.0.1:55321 | Docker, project id `lifeops` |
| Supabase Postgres | 127.0.0.1:55322 | user `postgres` (local dev password, see `supabase status`) |
| Supabase Studio (database browser) | http://127.0.0.1:55323 | |
| Mailpit (auth emails) | http://127.0.0.1:55324 | local sign-ups need no email confirmation |
| Ollama (local LLM, shared) | http://localhost:11434/v1 | container `cvfix-ollama`, model `llama3.1:8b` |

Reserved but switched off in `supabase/config.toml` (the app does not use them): shadow DB 55320,
analytics 55327, pooler 55329, edge-function inspector 8084.

## Prerequisites

- Windows 11 with PowerShell 5.1 or newer.
- **Docker Desktop running.** On this PC start it only with
  `powershell -ExecutionPolicy Bypass -File C:\Users\gopal\Downloads\start-docker-desktop.ps1`.
- **Node.js 22 or newer** (tested with 24.22.1; npm prints an "EBADENGINE" warning because
  `package.json` asks for 22.x, which is harmless).
- **Python 3.13** as `python` on PATH (for the FastAPI virtualenv).
- **Supabase CLI v3.** The scripts use `C:\Users\gopal\tools\supabase\supabase.exe` if it exists,
  otherwise `supabase` from PATH, or whatever `$env:SUPABASE_CLI` points to.
- **Ollama with `llama3.1:8b`** on port 11434. Check with `docker exec cvfix-ollama ollama list`.
  Without it the app still starts; AI answers then fail with a clear "Could not reach Ollama" message
  and the planner service falls back to its keyword planner.

## One-time setup

Nothing to do by hand. The start script, on its first run:

1. starts the local Supabase stack and applies the 9 migrations in `supabase/migrations`
   (the first start downloads the Supabase images, several minutes),
2. writes `.env.local` and `fastapi-backend/.env` from `supabase status` (local keys only, nothing is
   printed; a random `GOOGLE_OAUTH_STATE_SECRET` and a shared `LIFEOPS_BACKEND_TOKEN` are generated),
3. runs `npm install` and creates `fastapi-backend\.venv` with `requirements-dev.txt` if they are missing,
4. creates the local test user and stores it in `.local-test-user.json`.

All of these files are gitignored. To redo the env files later: `node scripts\write-local-env.mjs`
(it keeps values you changed by hand, except the Supabase URL and keys).

## Start and stop

From PowerShell:

```powershell
cd C:\Users\gopal\Downloads\cv-project-fixes\lifeops
powershell -ExecutionPolicy Bypass -File scripts\start-lifeops.ps1
```

It ends with the URLs above once both servers answer. Logs: `.run\web.log`, `.run\web.err.log`,
`.run\fastapi.log`, `.run\fastapi.err.log`. Process ids: `.run\pids.json`.

```powershell
powershell -ExecutionPolicy Bypass -File scripts\stop-lifeops.ps1               # web app, FastAPI and Supabase
powershell -ExecutionPolicy Bypass -File scripts\stop-lifeops.ps1 -KeepSupabase # leave the containers running
```

`supabase stop` keeps the database volume, so users, chats and calendars survive a restart. (Never use
`supabase stop --no-backup` unless you want to wipe the data.)

## Signing in

- **Test user:** open http://localhost:5190/login and sign in with the `email` and `password` in
  `.local-test-user.json`. Its profile is filled in and it uses the demo inbox and calendar, so it lands
  in the workspace. `node scripts\create-test-user.mjs --new` makes another one (and overwrites the file).
- **New account:** "Create account" on the login page. Locally there is no email confirmation; you go
  through *Profile* then *Connectors*. On *Connectors* choose **Use demo inbox & calendar** (Google is not
  configured on this PC; the page says so and "Connect Google" explains what is missing).
- **Anonymous demo:** "Try the live demo" on the login page (enabled by `VITE_ENABLE_ANONYMOUS_DEMO=true`
  in `.env.local`; anonymous sign-ins are on in `supabase/config.toml`).

## What to try

The AI is a local 8B model on the CPU: one answer typically takes 1 to 5 minutes, and much longer while
other programs use Ollama. The UI shows "Thinking..." meanwhile; requests time out after 15 minutes
(`LLM_TIMEOUT_MS`).

1. **Workspace** (`/app`): on the first visit MONDAY asks itself for an inbox and calendar briefing and
   ranks your priorities (stored in the `tasks` table, shown under *Priorities*). Then try
   - "Block 3–5 pm tomorrow for a gym push workout." → a proposal appears under *Today*; nothing is saved
     until you click **Save to Calendar**.
   - "Schedule 'Review lecture notes' tomorrow from 10:30 to 11:30." → overlaps the demo lecture
     (10:00–12:00); **Save** is refused with "This time overlaps ...".
   - "Draft a reply to Sam's email about lunch on Saturday: yes, 1 pm works." → *Insights* shows the
     reply; edit it and click **Save as draft**. It is stored as a draft (demo mailbox, or Gmail drafts
     when Google is connected). MONDAY has no send function at all.
   - "Move my dentist appointment to start at 4 pm the same day." → **Save changes** applies it.
   Reloading the page restores the chat history.
2. **Plan** (`/app/plan`): **Create plan** fills only the free slots (07:00–22:00 minus your events) of
   the week; items that do not fit a free slot are dropped. **Approve** a day or **Approve entire week**,
   or type "approve Saturday". Approving twice skips existing events; items that now overlap an event are
   held back and named.
3. **Calendar** (`/app/calendar`): week view of the demo calendar (badge "Demo data") or Google Calendar.
4. **Dashboard** (`/app/dashboard`): productivity numbers, top priorities, next 7 days, recent drafts, and
   the planner service: paste messy text into *From chaos to plan* → tasks and proposed actions appear in
   the *Action approval center* → **Approve** → **Run**. Calendar blocks are written to your calendar after
   the same conflict check, email actions become drafts only, and the *Execution log* shows where each
   action went. If the planner service is stopped, the page says so and the same text goes to the in-app
   assistant instead.
5. **Profile** (`/app/profile`): name, role and goals feed the prompts; *Manage Google connection*.

## Switching the AI provider

Both parts read OpenAI-compatible settings. Change them in **`.env.local`** (web app) and
**`fastapi-backend/.env`** (planner), then stop and start again.

| Provider | `LLM_BASE_URL` | `LLM_MODEL` (example) | `LLM_API_KEY` |
| --- | --- | --- | --- |
| Local Ollama (default) | `http://localhost:11434/v1` | `llama3.1:8b` | any (`ollama`) |
| Hugging Face router (original) | `https://router.huggingface.co/v1` | `meta-llama/Llama-3.1-8B-Instruct` | `hf_...` token with inference credits |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` | `sk-...` |
| Google Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-2.0-flash` | Gemini API key |
| Lovable AI gateway (original Lovable build) | `https://ai.gateway.lovable.dev/v1` | `google/gemini-2.5-flash` | Lovable-issued key |

Web app extras: `LLM_STRUCTURED_OUTPUT=json_schema` (constrained JSON; keep it for Ollama) or `tools`
(OpenAI function calling, the original behaviour, works with OpenAI/Hugging Face); per-role models
`LLM_MODEL_CHAT`, `LLM_MODEL_PLAN`, `LLM_MODEL_DRAFT`; `LLM_FALLBACK_MODEL` (Hugging Face defaults to
`meta-llama/Meta-Llama-3-8B-Instruct`); `LLM_TIMEOUT_MS`; `LLM_MAX_TOKENS` (and `LLM_MAX_TOKENS_PLAN`).
Leaving `LLM_BASE_URL` empty and setting only `HUGGINGFACE_API_KEY` gives the original Hugging Face setup.
Note: Gopal's Hugging Face token is valid but the account has no inference credits; the router answers
HTTP 402 and the app shows "Hugging Face credits exhausted for this token."

Planner extras (`fastapi-backend/.env`): `LLM_RESPONSE_FORMAT=json_schema` or `json_object`,
`LLM_TIMEOUT_SECONDS`, `LLM_MAX_TOKENS`. Empty `LLM_BASE_URL` = keyword planner only.
`LIFEOPS_BACKEND_URL=off` in `.env.local` makes the dashboard always use the in-app assistant.

## Tests

```powershell
cd C:\Users\gopal\Downloads\cv-project-fixes\lifeops
npm test                 # 35 unit tests (vitest): LLM gateway, time ranges and conflicts, Google OAuth offline
npm run typecheck
npm run lint             # 0 errors (8 old fast-refresh warnings)
npm run build
cd fastapi-backend
.venv\Scripts\python.exe -m pytest     # 13 API tests with a temporary SQLite file and a fake LLM
```

`npm run check` runs lint, typecheck, unit tests and build in one go. The Google tests never touch the
network: the OAuth token, userinfo, Calendar and Gmail endpoints are mocked, and they cover state
signing and expiry, the redirect URI, token storage and refresh, calendar create/list, and draft-only Gmail.

Browser end-to-end checks (headless Edge, Playwright) live outside the repo in
`C:\Users\gopal\Downloads\cv-project-fixes\_e2e\lifeops-fix\`; run them from `..\_e2e` with the stack up,
e.g. `node lifeops-fix\auth.mjs`, `node lifeops-fix\chat.mjs`, `node lifeops-fix\plan.mjs`,
`node lifeops-fix\dashboard.mjs`. Results are appended to `lifeops-fix\results.jsonl`, screenshots next to it.

## What only Gopal can do: connect real Gmail and Google Calendar

The code path is in place and tested against mocked Google endpoints, but it needs an OAuth client in
Gopal's Google Cloud account:

1. Open https://console.cloud.google.com/ with the Google account that owns the project, create a project
   (for example "MONDAY local").
2. *APIs & Services → Library*: enable **Gmail API** and **Google Calendar API**.
3. *APIs & Services → OAuth consent screen* (Google Auth Platform → Branding / Audience / Data access):
   user type **External**, app name "MONDAY", your support and developer email.
   Scopes: `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile`,
   `.../auth/gmail.readonly`, `.../auth/gmail.compose`, `.../auth/calendar.events`.
   Leave the app in **Testing** and add your own Gmail address under **Test users**.
4. *Credentials → Create credentials → OAuth client ID*, type **Web application**:
   - Authorised JavaScript origins: `http://localhost:5190`
   - Authorised redirect URIs: `http://localhost:5190/api/public/google/callback` (exactly this)
5. Put the two values into `.env.local` (never into a `VITE_` variable):
   ```
   GOOGLE_OAUTH_CLIENT_ID=<client id>.apps.googleusercontent.com
   GOOGLE_OAUTH_CLIENT_SECRET=<client secret>
   ```
   `GOOGLE_OAUTH_STATE_SECRET` is already there. Restart with the stop and start scripts.
6. Sign in, open *Profile → Manage Google connection* (or the Connectors step) and click
   **Connect Google**. Google warns that the app is unverified; continue as the test user. You come back
   to `/onboarding/connectors?google=connected`; Gmail and Calendar then replace the demo data.
7. Disconnect from the same page (it also revokes the token at Google).

Because `gmail.readonly` is a restricted scope, anything beyond private testing needs Google's app
verification. Optional and separate: the Supabase "Continue with Google" login button
(`VITE_ENABLE_GOOGLE_SIGNIN=true`) also needs `[auth.external.google]` set in `supabase/config.toml` with
the same client and the redirect URI `http://127.0.0.1:55321/auth/v1/callback` added to the client.

Other things only Gopal can do: add credits to the Hugging Face account (or another provider key) to use
a hosted model, and deploy (see `VERCEL_DEPLOYMENT.md`, not exercised here).

## Known limits

- Speed and quality of the local model: answers take minutes on this CPU. The 8B model sometimes does not
  produce the card you asked for (no proposal, no draft); rephrase and try again. Every model answer is
  validated on the server (times, free slots, conflicts, known email ids), so bad answers are dropped,
  not saved.
- Real Gmail and Google Calendar were never exercised on this PC (no OAuth client); only the demo data and
  the mocked-endpoint tests.
- The first workspace visit always sends one briefing request to the model.
- The planner service keeps its data in SQLite and creates tables at start-up without migrations; after
  pulling schema changes delete `fastapi-backend\lifeops.db`.
- The planner's own Gmail/Calendar adapters are still mock (as in the hackathon). Real writes happen in the
  web app when you click **Run** on the dashboard.
- `fastapi-backend/lifeos/` is an unrelated Next.js prototype from the hackathon; it is not used or built.
