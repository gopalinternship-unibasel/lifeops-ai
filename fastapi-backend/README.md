# LifeOps AI Backend

A FastAPI backend for the LifeOps AI hackathon project.

It turns chaotic user input into:

- tasks
- prioritized execution plan
- calendar block proposals
- Gmail draft proposals
- safe action execution workflow

The backend is designed for a frontend dashboard with:

- input box
- before/after view
- task list
- action approvals
- autonomous mode toggle

## Quick start

In this repository the service is started together with the MONDAY web app by
`scripts/start-lifeops.ps1` (see `../RUNNING.md`). To run it on its own:

```bash
cd fastapi-backend
python -m venv .venv

# Windows PowerShell
.venv\Scripts\Activate.ps1

# macOS/Linux
source .venv/bin/activate

pip install -r requirements-dev.txt
uvicorn app.main:app --host 127.0.0.1 --port 8010
```

Open (with `ENV=local` or `ENV=development`; a hosted planner, where `ENV` is unset or `production`,
serves no `/docs`, `/redoc` or `/openapi.json`):

```text
http://127.0.0.1:8010/docs
```

Run the tests with `python -m pytest` (they use a temporary SQLite file and a fake LLM).

## Core demo flow

1. Frontend sends messy input to:

```http
POST /api/plan
```

Example body:

```json
{
  "user_input": "I have exams next week, 2 assignments, and a meeting tomorrow",
  "autonomous_mode": false
}
```

2. Backend creates:

- tasks
- action proposals
- calendar block proposals
- email draft proposals

3. Frontend displays:

```http
GET /api/dashboard
```

4. User approves actions:

```http
POST /api/actions/{action_id}/approve
```

5. User executes approved actions:

```http
POST /api/actions/{action_id}/execute
```

## Safety model

Low-risk actions:

- create task
- create reminder
- create calendar block
- create email draft

High-risk actions:

- send email
- delete calendar event
- cancel/reschedule existing meetings

The MVP only creates drafts and calendar proposals. Sending emails is intentionally not implemented.

## LLM behavior

The planner calls any OpenAI-compatible chat-completions API (settings in `.env`, see `.env.example`):

| Setting                                 | Meaning                                                                                                                                                                                       |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LLM_BASE_URL`                          | e.g. `http://localhost:11434/v1` (local Ollama), `https://router.huggingface.co/v1`, `https://api.openai.com/v1`                                                                              |
| `LLM_API_KEY`                           | key for hosted providers (any value for Ollama)                                                                                                                                               |
| `LLM_MODEL`                             | e.g. `llama3.1:8b`                                                                                                                                                                            |
| `LLM_RESPONSE_FORMAT`                   | `json_schema` (constrained output), `json_object`, or `none` (no `response_format` sent; the first JSON object in the answer's text is used, as for Cloudflare Workers AI in the hosted demo) |
| `LLM_TIMEOUT_SECONDS`, `LLM_MAX_TOKENS` | limits per call                                                                                                                                                                               |
| `LLM_EXTRA_BODY`                        | optional JSON object added to every model request; on Cloudflare Workers AI `{"chat_template_kwargs":{"enable_thinking":false}}` turns thinking off                                           |
| `PLANNER_MODE`                          | `auto` (default: the model when one is configured) or `keyword` (always the keyword planner)                                                                                                  |
| `ENV`                                   | unset or `production` (hosted), `local` (serves `/docs`), `development` (also logs every SQL statement with its values)                                                                       |

If no LLM is configured (`LLM_BASE_URL` and `OPENAI_API_KEY` unset), or the model call fails or returns
nothing usable, the deterministic keyword planner runs so the demo always works. Each plan response says
which one ran (`planner: "llm" | "demo"`, plus `planner_note`, a plain sentence for the user; the
technical reason is in the log). The model's answer is validated item by item: unknown action types are
dropped (there is no "send email" action), calendar blocks need a valid time range, medium/high risk
actions always require approval, common quirks are repaired (`""` or `null` fields, numbers as text,
out-of-range priorities and estimates are clamped), and texts are cut to what the MONDAY app can store.

The keyword planner recognises exams, assignments and meetings as whole words and simple dates
("tomorrow", "Friday", "Friday next week", "2026-11-28", "28 Nov"; weeks start on Monday). It leaves
a deadline empty when it cannot read one exactly ("next week", "Friday after next", or "next Friday",
which can mean this coming Friday or the one after) and asks the user to confirm it, and its
proposals always need approval, because their times are guesses.

## Users and the shared secret

Every `/api` request may carry `X-LifeOps-User: <id>`; tasks, actions, plan runs and settings are kept per
user (requests without the header share the `local` workspace). When `LIFEOPS_BACKEND_TOKEN` is set,
`/api` requests must also send `Authorization: Bearer <token>` (or `X-LifeOps-Token`). The MONDAY app's
server sends both; the browser never calls this service directly.

`POST /api/actions/{id}/execute` optionally takes `{"provider", "external_id", "result"}`: the caller
already carried out the approved action (the MONDAY app writes calendar blocks to the user's calendar
and saves drafts) and the service records the outcome instead of running its mock adapters (whose
provider names are `mock_calendar` and `mock_gmail`). An executed action keeps its first outcome: a
repeat without a body, or with the same provider and external id, answers with the stored outcome; a
different outcome answers 409. Approve, reject and execute change the status only if no other request
changed it in the meantime; the one that loses answers 409.

`POST /api/plan` takes these optional fields besides `user_input`:

| Field              | Meaning                                                                                                                                                         |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `current_datetime` | the user's local wall-clock time; with an offset it is converted to `timezone`. Without it, the current time in `timezone` is used.                             |
| `timezone`         | the user's IANA zone, for example `Europe/Zurich`                                                                                                               |
| `busy`             | up to 200 `{title, start, end}` busy times (naive local); proposed blocks and reminders are moved off them                                                      |
| `deadline`         | when the caller stops waiting (UTC). The model gets at most the time left; a plan ready only after it is not stored (504).                                      |
| `idempotency_key`  | up to 100 characters chosen by the caller. A repeat with the same key and text returns the stored answer (no second plan); the same key with another text: 409. |
| `autonomous_mode`  | `true` runs low-risk actions that need no approval at once; `false` never does; left out, the stored setting (`/api/settings/autonomous-mode`) applies.         |

The idempotency key fully covers a retry sent after the first request has finished. Two requests with
the same key sent at the same moment both pass the check, so each calls the model (two AI uses) and,
in autonomous mode, each runs its safe actions; only the plan stored first is kept, both get it, and
the second plan's rows are rolled back (the planner logs this).

`GET /api/dashboard?limit=N` lists at most N tasks and N actions (default 200, at most 500; open ones
first); the `metrics` always count all of them.

## Data kept

Everything is stored per owner (the `X-LifeOps-User` value) in five tables: `appsettings`, `task`,
`actionproposal`, `planrun` and `planidempotencykey`. The planner never deletes plans, tasks or actions
itself; it deletes the stored answers of idempotency keys after two days. The owner is plain text with
no link to the MONDAY app's users, so on the hosted project the nightly clean-up must delete the planner
rows of users it deletes (`supabase/hosted/cleanup_anonymous_users.sql`).

## Frontend contract

Useful endpoints:

```http
POST /api/plan
GET /api/tasks
GET /api/actions
POST /api/actions/{id}/approve
POST /api/actions/{id}/reject
POST /api/actions/{id}/execute
POST /api/actions/execute-safe
GET /api/dashboard
POST /api/settings/autonomous-mode
GET /api/settings
```

## Recommended frontend screens

- `/` chaos input screen
- `/dashboard` after-state dashboard
- `/actions` approval center
- `/tasks` task board
