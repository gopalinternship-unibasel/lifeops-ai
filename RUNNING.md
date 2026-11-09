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
| Ollama (local LLM, shared) | http://localhost:11434/v1 | container `cvfix-ollama`; local default model `qwen2.5-3b-4threads` |

Reserved but switched off in `supabase/config.toml` (the app does not use them): shadow DB 55320,
analytics 55327, pooler 55329, edge-function inspector 8084.

## The AI model

- **Intended model: Llama 3.1 8B**, as in the hackathon build: `meta-llama/Llama-3.1-8B-Instruct` on the
  Hugging Face router (fallback `meta-llama/Meta-Llama-3-8B-Instruct`), or `llama3.1:8b` in Ollama.
- **Local default on this PC: `qwen2.5-3b-4threads`**: the Qwen 2.5 3B Instruct weights of
  `qwen2.5:3b`, run with 4 CPU threads and an 8192-token context
  (`ollama/qwen2.5-3b-4threads.Modelfile`). Why a 3B model: the Ollama here is CPU only and shared
  with other projects; under load `llama3.1:8b` took 268 s to load and then generated 0.06 tokens/s,
  while Qwen 2.5 3B returned valid structured answers to MONDAY's real prompts (a calendar proposal in
  the chat, a plan with tasks and a calendar block from the planner service). Why 4 threads, measured
  in the Ollama log on 9 Nov 2026: `qwen2.5:3b` with Ollama's default (all 8 threads, on a CPU with 4
  performance and 4 low-power cores, while other work kept the PC busy) generated **0.45 tokens/s**;
  the same weights with 4 threads generated **4.2 to 5.6 tokens/s** in the same hour. And why exactly
  these settings: Ollama keeps one runner per weights file, so `qwen2.5:3b` (defaults) and another
  project's `qwen2.5-3b-4threads` kept unloading each other, each waiting for the other's running
  request first (QA saw a 9-minute wait before MONDAY's model even started). With the same name and
  settings both projects share one loaded runner. If the model is missing, the start script prints
  how to create it from the Modelfile (two commands, no download beyond `qwen2.5:3b`).
- Switch to Llama 3.1 8B (or back) with one command, then restart:
  ```powershell
  node scripts\write-local-env.mjs --model llama3.1:8b     # or: --model qwen2.5-3b-4threads, --model qwen2.5:3b
  ```
  It sets `LLM_MODEL` in both `.env.local` and `fastapi-backend\.env`. A hosted provider is one more
  setting away (see "Switching the AI provider").

## Prerequisites

- Windows 11 with Windows PowerShell 5.1 (or PowerShell 7).
- **Docker Desktop running.** On this PC start it only with
  `powershell -ExecutionPolicy Bypass -File C:\Users\gopal\Downloads\start-docker-desktop.ps1`.
- **Node.js 22 or newer** (tested with 24.22.1; npm prints an "EBADENGINE" warning because
  `package.json` asks for 22.x, which is harmless).
- **Python 3.13** as `python` on PATH (for the FastAPI virtualenv).
- **Supabase CLI v3.** The scripts use `C:\Users\gopal\tools\supabase\supabase.exe` if it exists,
  otherwise `supabase` from PATH, or whatever `$env:SUPABASE_CLI` points to.
- **Ollama with the model in `.env.local`** (default `qwen2.5-3b-4threads`) on port 11434. Check with
  `docker exec cvfix-ollama ollama list`; the start script warns if the model is missing and prints the
  `ollama pull` command, or for `qwen2.5-3b-4threads` the two commands that create it from
  `ollama\qwen2.5-3b-4threads.Modelfile`. Without Ollama the app still starts; AI answers then fail with a clear
  "Could not reach Ollama" message and the planner service falls back to its keyword planner.

## One-time setup

Nothing to do by hand. The start script, on its first run:

1. starts the local Supabase stack and applies the 11 migrations in `supabase/migrations`
   (the first start downloads the Supabase images, several minutes); on every later run
   `supabase migration up` applies migrations added since, so an existing database keeps up,
2. writes `.env.local` and `fastapi-backend/.env` from `supabase status` (local keys only, nothing is
   printed: the status that `supabase start` prints with the local keys is dropped; a random
   `GOOGLE_OAUTH_STATE_SECRET` and a shared `LIFEOPS_BACKEND_TOKEN` are generated),
3. runs `npm install` and creates `fastapi-backend\.venv` with `requirements-dev.txt` if they are missing,
4. creates the local test user and stores it in `.local-test-user.json`.

All of these files are gitignored. To redo the env files later: `node scripts\write-local-env.mjs`
(it keeps values you changed, except the Supabase URL and keys).

## Start and stop

From PowerShell:

```powershell
cd C:\Users\gopal\Downloads\cv-project-fixes\lifeops
powershell -ExecutionPolicy Bypass -File scripts\start-lifeops.ps1
```

It takes about 1.5 minutes when Supabase is already set up and ends with the URLs above once both
servers answer. Logs: `.run\web.log`, `.run\web.err.log`, `.run\fastapi.log`, `.run\fastapi.err.log`.
Process ids (the `cmd.exe` wrappers of the two servers): `.run\pids.json`. The script returns even when
its output is piped (for example `| Tee-Object start.log`).

It waits up to 600 s for each server (`-WaitSeconds 1200` for more) and prints a "still waiting" line
every 30 s: a first start (fresh virtualenv, Vite's first dependency scan) on a busy PC is slow, the
FastAPI planner once needed 158 s. If a server stops on its own or does not answer in time, the script
prints the end of its log, stops the two servers it started (Supabase stays up) and exits with 1, so
running it again works without calling the stop script first.

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

Every AI answer comes from the local model: about 1 to 2.5 minutes on this PC when the shared Ollama is
not busy with other work, longer when it is (see "Known limits"). The UI shows "Thinking..."
meanwhile; requests time out after 15 minutes (`LLM_TIMEOUT_MS`).

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
     Changes for event ids that are not in your calendar are ignored. Replies and cards show times in
     your local time with the day ("Tomorrow 3:00 PM–5:00 PM", "Wed, Nov 11, 4:00 PM – 5:30 PM").
   Reloading the page restores the chat history. Cards you saved, applied or dismissed stay that way
   (stored in the `chat_card_actions` table): they are not offered again after a reload or in another
   tab, and a second **Save** of the same card, from a tab that still shows it, is refused ("This
   proposal was already saved.", "This reply is already saved as a draft (not sent)."), so no second
   event or draft is written. A saved reply comes back read-only with the text you saved.
   *Today's schedule* lists only today; an event saved for another day is in the calendar.
   Messages are limited to 4,000 characters (the box stops there and shows a counter near the limit);
   if anything still sends a longer one, the answer is one sentence, not a JSON error.
   If the model does not answer the automatic first-visit briefing (timeout, Ollama unreachable), the
   briefing is put together by rules instead and says so: unread emails, today's events, and
   priorities ranked by the same rule the model is given (stored as tasks with source `rules`). An
   email task about one of today's remaining events is the same commitment and is ranked once, in the
   event's line (the demo's 7 PM team sync and Alicia's "Team sync moved to 7 PM today" email: one
   priority, "also in Alicia (manager)'s email ..."). Every other request shows the model's error as
   a sentence, for example "Ollama is not available right now (HTTP 503: ...). Try again in a
   moment.", with the provider's own message but never its raw JSON body (that goes to the server log).
   **Reloading while MONDAY is still answering** (or opening the workspace in another tab) loses
   nothing: every request runs to the end on the server and stores its answer, or its error, in the
   chat. The page shows the message with "Thinking..." and "Still answering your last message",
   keeps the box disabled, checks every 4 s and then shows the answer and its cards. A request that
   was cut off (for example the dev server was stopped) is noted under the message once it is older
   than the longest a request can take (the model timeout plus 2 minutes), so the page never waits
   forever.
2. **Plan** (`/app/plan`): **Create plan** fills only the free slots (07:00–22:00 minus your events) of
   the week that are still ahead: today's slots start at the next quarter hour, days that are over get
   none ("Day already over"). Items the model places outside a free slot, in the past or on top of an
   event are dropped. **Approve** a day or **Approve entire week**, or type "approve Saturday". Approving
   twice skips existing events; items whose time has passed (in a plan made earlier) are skipped and
   counted; items that now overlap an event (the calendar changed since the plan was made) are held back
   and named. Moving a plan item into the past is refused.
3. **Calendar** (`/app/calendar`): week view of the demo calendar (badge "Demo data") or Google Calendar.
4. **Dashboard** (`/app/dashboard`): productivity numbers, top priorities, next 7 days, recent drafts, and
   the planner service: paste messy text into *From chaos to plan* → tasks and proposed actions appear in
   the *Action approval center* → **Approve** → **Run**. Calendar blocks are written to your calendar after
   the same conflict check, email actions become drafts only, actions the model invents (for example
   "send_email") are dropped, and the *Execution log* shows where each action went. If the planner
   service is stopped, the page says so and the same text goes to the in-app assistant instead.
   Each **Plan it** is stored (table `planner_requests`) and runs to the end on the server, the
   in-app assistant included, so a reload while it runs shows "Still planning ..." (Plan it disabled)
   and then the result; the last result stays on the page with its time. A failed or cut-off request
   says so.
5. **Profile** (`/app/profile`): name, role and goals feed the prompts; *Manage Google connection*.

## Switching the AI provider

Both parts read OpenAI-compatible settings: the web app from **`.env.local`**, the planner from
**`fastapi-backend\.env`**. Change them, then stop and start again.

- With the helper (writes UTF-8 without a byte-order mark, keeps everything else):
  ```powershell
  node scripts\write-local-env.mjs --model llama3.1:8b
  node scripts\write-local-env.mjs --set LLM_BASE_URL=https://api.openai.com/v1 --set LLM_MODEL=gpt-4o-mini `
      --backend-set LLM_BASE_URL=https://api.openai.com/v1 --backend-set LLM_MODEL=gpt-4o-mini
  ```
- Put API keys in with a text editor (Notepad is fine), not on the command line: `LLM_API_KEY=...` in
  both files. Avoid `Set-Content -Encoding utf8` in Windows PowerShell 5.1: it adds a byte-order mark.
  (The loaders now tolerate one, and every run of the start script rewrites both files without it.)

| Provider | `LLM_BASE_URL` | `LLM_MODEL` (example) | `LLM_API_KEY` |
| --- | --- | --- | --- |
| Local Ollama (default) | `http://localhost:11434/v1` | `qwen2.5-3b-4threads` (default), `qwen2.5:3b`, `llama3.1:8b` (intended) | any (`ollama`) |
| Hugging Face router (original) | `https://router.huggingface.co/v1` | `meta-llama/Llama-3.1-8B-Instruct` | `hf_...` token with inference credits |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` | `sk-...` |
| Google Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-2.0-flash` | Gemini API key |
| Lovable AI gateway (original Lovable build) | `https://ai.gateway.lovable.dev/v1` | `google/gemini-2.5-flash` | Lovable-issued key |

Web app extras: `LLM_STRUCTURED_OUTPUT=json_schema` (constrained JSON; keep it for Ollama) or `tools`
(OpenAI function calling, the original behaviour, works with OpenAI/Hugging Face); per-role models
`LLM_MODEL_CHAT`, `LLM_MODEL_PLAN`, `LLM_MODEL_DRAFT`; `LLM_FALLBACK_MODEL` (Hugging Face defaults to
`meta-llama/Meta-Llama-3-8B-Instruct`); `LLM_TIMEOUT_MS`; `LLM_MAX_TOKENS` and `LLM_MAX_TOKENS_PLAN`
(2400, a week plan is long). Leaving `LLM_BASE_URL` empty and setting only `HUGGINGFACE_API_KEY` gives the
original Hugging Face setup. Note: Gopal's Hugging Face token is valid but the account has no inference
credits; the router answers HTTP 402 and the app shows "Hugging Face credits exhausted for this token."

Planner extras (`fastapi-backend\.env`): `LLM_RESPONSE_FORMAT=json_schema` or `json_object`,
`LLM_TIMEOUT_SECONDS`, `LLM_MAX_TOKENS`, `PLANNER_MODE=keyword` (always the keyword planner). Empty
`LLM_BASE_URL` = keyword planner only. `LIFEOPS_BACKEND_URL=off` in `.env.local` makes the dashboard
always use the in-app assistant.

## Tests

```powershell
cd C:\Users\gopal\Downloads\cv-project-fixes\lifeops
npm test                 # 70 unit tests (vitest): LLM gateway and readable provider errors, time ranges, conflicts
                         # and free slots from now on, Google OAuth offline, env files, readable input errors,
                         # workspace card state, rule-based briefing (one line per commitment, inbox coverage),
                         # reply and plan-request state, dates in the chat prompt
npm run typecheck
npm run lint             # 0 errors (8 old fast-refresh warnings)
npm run build
cd fastapi-backend
.venv\Scripts\python.exe -m pytest     # 16 API tests with a temporary SQLite file and a fake LLM
```

`npm run check` runs lint, typecheck, unit tests and build in one go. The Google tests never touch the
network: the OAuth token, userinfo, Calendar and Gmail endpoints are mocked, and they cover state
signing and expiry, the redirect URI, token storage and refresh, calendar create/list, and draft-only Gmail.

**Browser end-to-end checks** (headless Edge, Playwright 1.56.1) live outside the repo in
`C:\Users\gopal\Downloads\cv-project-fixes\_e2e\lifeops-fix\` and run from `..\_e2e` with the stack up.
Results are appended to `lifeops-fix\results.jsonl`, screenshots go next to the scripts.

```powershell
cd C:\Users\gopal\Downloads\cv-project-fixes\_e2e
node lifeops-fix\auth.mjs         # sign-up, profile, connectors, Connect Google message, sign-in, anonymous demo
node lifeops-fix\calendar.mjs     # demo calendar week view, profile, row-level security between two users
node lifeops-fix\chat.mjs         # briefing + priorities, proposed block, conflict refusal, draft, move, cancel, history
node lifeops-fix\plan.mjs refine  # free-slot week plan, dropped invalid items, held-back conflict, approvals
node lifeops-fix\dashboard.mjs    # planner service: tasks, approval gate, run, drafts only, execution log
node lifeops-fix\dashboard.mjs offline   # with the planner stopped: in-app assistant fallback
```

`chat.mjs` expects a user without chat history (the first visit starts the briefing); steps can be
picked by name, for example `node lifeops-fix\chat.mjs block draft`. For the `offline` run, stop only the
planner first (`taskkill /PID <fastapi id from .run\pids.json> /T /F`). `$env:E2E_MESSY` replaces the
dashboard's messy input (a shorter one keeps a slow model's answer short).

`$env:E2E_USER_FILE` picks another test user file (create one with
`node scripts\create-test-user.mjs --new --file .run\e2e-user.json`). With the real local model the
chat, plan and dashboard stages take a long time (one answer per step); set `$env:LLM_WAIT_MS` to the
wait per answer in milliseconds (default 25 minutes).

**Fast run with a scripted model.** `..\_e2e\lifeops-fix2\scripted-llm.mjs` is an OpenAI-compatible test
double on http://127.0.0.1:55326/v1. It answers MONDAY's real requests instantly, in the requested JSON
shape, and deliberately includes bad items (plan items on top of events or after 22:00, a change for an
unknown event id, a `send_email` action, a planner block over the lecture) so the checks can prove that
the app drops or refuses them. To use it:

```powershell
cd C:\Users\gopal\Downloads\cv-project-fixes\_e2e
Start-Process node -ArgumentList "lifeops-fix2\scripted-llm.mjs" -WindowStyle Hidden
cd ..\lifeops
node scripts\write-local-env.mjs --set LLM_BASE_URL=http://127.0.0.1:55326/v1 --backend-set LLM_BASE_URL=http://127.0.0.1:55326/v1
# restart (stop + start), run the stages with $env:E2E_SCRIPTED_LLM=1 for the extra planner checks, then go back:
node scripts\write-local-env.mjs --set LLM_BASE_URL=http://localhost:11434/v1 --backend-set LLM_BASE_URL=http://localhost:11434/v1
```

**Round-3 checks** (9 Nov 2026, the fixes after the first QA pass) live in `..\_e2e\lifeops-fix3\`. They
use `fake-llm.mjs`, a copy of QA's independent test double (127.0.0.1:55328) that also puts a 07:00 item
on every plan day and answers HTTP 503 to users whose profile name contains "Fallback".
`start-fake.ps1` runs this project's own start script with process environment overrides (fake model,
separate planner SQLite file), so no env file changes. Each script takes the suffix of a user file
`.run\fix3-user-<suffix>.json` (create one with `node scripts\create-test-user.mjs --new --file .run\fix3-user-x.json`);
results go to `lifeops-fix3\results.jsonl`, screenshots to `lifeops-fix3\shots\`.

```powershell
cd C:\Users\gopal\Downloads\cv-project-fixes\_e2e
powershell -ExecutionPolicy Bypass -File lifeops-fix3\start-fake.ps1
node lifeops-fix3\chat.mjs c     # handled cards after reload and in a stale tab, Today = today only, local times, length limit
node lifeops-fix3\plan.mjs p     # no plan items in the past, approval skips past items
node lifeops-fix3\fallback.mjs f # rule-based first-visit briefing when the model fails
node lifeops-fix3\dash.mjs d online   # planner service (copy of QA's check)
node lifeops-fix3\dash.mjs d offline  # with the planner stopped: fallback card saved once
node lifeops-fix3\favicon.mjs c  # favicon served, no 404 in the console
node lifeops-fix3\rls.mjs p f    # row-level security of chat_card_actions between two users
node lifeops-fix3\real-briefing.mjs r   # with the DEFAULT config (real model): model answer or rule-based fallback
```

**Round-4 checks** (9 Nov 2026, the fixes after the second QA pass) live in `..\_e2e\lifeops-fix4\`: the
same layout (`start-fake.ps1`, user files `.run\fix4-user-<suffix>.json`, `results.jsonl`, `shots\`), copies
of the round-3 scripts, and a `fake-llm.mjs` that also answers HTTP 503 `{"error":{"message":"QA double:
model unavailable"}}` to "Fallback" users, HTTP 500 with a JSON body without a message to "Broken" users,
and answers "Slow" users (and planner inputs containing `SLOW`) only after 45 s (`$env:SLOW_MS`), so a
page can be reloaded while a request runs.

```powershell
cd C:\Users\gopal\Downloads\cv-project-fixes\_e2e
powershell -ExecutionPolicy Bypass -File lifeops-fix4\start-fake.ps1
node lifeops-fix4\errors.mjs f k            # readable 503/500 errors, failed turn stored, team sync ranked once
node lifeops-fix4\reload.mjs chat s         # reload during the briefing and during a message: answer and card arrive
node lifeops-fix4\reload.mjs dash d         # reload during "Plan it" (planner service): "Still planning", then the result
node lifeops-fix4\reload.mjs interrupted r  # a request cut off 3 hours ago: a note, no endless wait, no new briefing
node lifeops-fix4\rls-planner.mjs p f       # row-level security of planner_requests between two users
# stop only the planner (taskkill /PID <fastapi id from .run\pids.json> /T /F), then:
node lifeops-fix4\reload.mjs dash-offline s2   # reload while the in-app assistant plans
node lifeops-fix4\inapp-card-after-reload.mjs d  # after dash.mjs d offline: the saved card does not come back
# with the DEFAULT config (start-lifeops.ps1, real local model):
node lifeops-fix4\real.mjs briefing x       # first-visit briefing; also: real.mjs chat x, real.mjs plan x
```

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
5. Put the two values into `.env.local` with a text editor (never into a `VITE_` variable):
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

- **Speed of the local model.** With the default `qwen2.5-3b-4threads`, measured on 9 Nov 2026 between
  19:50 and 20:10 (Docker VM load average 1-7; another project loaded `qwen2.5:7b` in the same Ollama
  at 19:54): first-visit briefings were answered by the model in 87, 98, 125 and 148 s (about 2,000
  prompt tokens at 12-20 tokens/s, 105-417 answer tokens at 3-6 tokens/s; the 148 s include 14 s to
  load the model), a briefing interrupted by a reload arrived 67 s after the reload, the chat request
  "Block 7-8 am on Thursday for a morning run." took 66 and 107 s, and the planner service 75 s
  (369 answer tokens at 6.6 tokens/s). The model was loaded once (19:50) and served every request
  without being reloaded. Before the change, with `qwen2.5:3b` and Ollama's default threads, QA
  measured 0.42 tokens/s, a planner answer after 820 s and two chat requests that hit the 15-minute
  timeout, and earlier the same day a chat answer took 39 minutes and a planner answer 58 minutes
  (load average about 20, Windows CPU at 100%). The causes, from the Ollama log: all 8 threads on a
  CPU with 4 low-power cores that other work keeps busy, and `qwen2.5:3b` and another project's
  `qwen2.5-3b-4threads` (the same weights file with other settings) unloading each other, each
  waiting for the other's running request. Still true: the shared Ollama answers one request at a
  time per model, so a request waits while another project's long request on the same model runs
  (their requests took 1 to 12 minutes today), and the PC's load changes the speed several times over.
  If requests time out, raise `LLM_TIMEOUT_MS` in `.env.local` and `LLM_TIMEOUT_SECONDS` in
  `fastapi-backend\.env`, or use a hosted provider:
  ```powershell
  node scripts\write-local-env.mjs --set LLM_TIMEOUT_MS=3600000 --backend-set LLM_TIMEOUT_SECONDS=3600
  ```
  The first-visit briefing falls back to rules after the timeout, and a reload never loses an answer
  that arrives later.
- **Context: 8192 tokens** with `qwen2.5-3b-4threads` (Ollama's default for other models is 4096). A
  long chat history makes the prompt grow; the app sends the newest 10 messages and Ollama drops the
  oldest ones first if it still does not fit.
- **Node's 5-minute fetch limit.** Node's built-in fetch gives up when response headers take longer than
  300 s. `vite.config.ts` lifts that limit for `vite dev` (the local setup); a Node production server
  would need the same `undici` Agent setting, Cloudflare Workers do not have the limit.
- A small model sometimes does not produce the card you asked for (no proposal, no draft); rephrase and
  try again. Every model answer is validated on the server (times, free slots, conflicts, known email and
  event ids), so bad answers are dropped, not saved.
- Real Gmail and Google Calendar were never exercised on this PC (no OAuth client); only the demo data and
  the mocked-endpoint tests.
- **Quality of a 3B model.** The first workspace visit always sends one briefing request to the model.
  In five real briefings on 9 Nov 2026 `qwen2.5-3b-4threads` never returned priorities, and its text
  twice missed or misstated the inbox (a read email listed as unread and one left out; "No unread
  emails" next to four). The app now ranks the priorities by rule when the model gives none, lists
  the inbox and today's events from the data when the model's text leaves one out (both say so in the
  reply), and ignores calendar proposals in the briefing (the model had proposed today's existing
  events again). The chat once put "Thursday" on the wrong date before the prompt listed the dates of
  the next 8 days. Proposals always wait for **Save** and pass the conflict check, but read them before
  saving; `llama3.1:8b` (the intended model) or a hosted model writes better answers, more slowly here.
- Success toasts appear over the top-right header buttons for a few seconds (they pause while the mouse is
  over them).
- The planner service keeps its data in SQLite and creates tables at start-up without migrations; after
  pulling schema changes delete `fastapi-backend\lifeops.db`.
- The planner's own Gmail/Calendar adapters are still mock (as in the hackathon). Real writes happen in the
  web app when you click **Run** on the dashboard.
- `fastapi-backend/lifeos/` is an unrelated Next.js prototype from the hackathon; it is not used or built.
