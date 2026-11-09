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

Open:

```text
http://127.0.0.1:8010/docs
```

Run the tests with `python -m pytest` (13 tests; they use a temporary SQLite file and a fake LLM).

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

| Setting | Meaning |
| --- | --- |
| `LLM_BASE_URL` | e.g. `http://localhost:11434/v1` (local Ollama), `https://router.huggingface.co/v1`, `https://api.openai.com/v1` |
| `LLM_API_KEY` | key for hosted providers (any value for Ollama) |
| `LLM_MODEL` | e.g. `llama3.1:8b` |
| `LLM_RESPONSE_FORMAT` | `json_schema` (constrained output) or `json_object` |
| `LLM_TIMEOUT_SECONDS`, `LLM_MAX_TOKENS` | limits per call |

If no LLM is configured (`LLM_BASE_URL` and `OPENAI_API_KEY` unset), or the model call fails or returns
nothing usable, the deterministic keyword planner runs so the demo always works. Each plan response says
which one ran (`planner: "llm" | "demo"`, plus `planner_note`). The model's answer is validated item by
item: unknown action types are dropped (there is no "send email" action), calendar blocks need a valid
time range, and medium/high risk actions always require approval.

## Users and the shared secret

Every `/api` request may carry `X-LifeOps-User: <id>`; tasks, actions, plan runs and settings are kept per
user (requests without the header share the `local` workspace). When `LIFEOPS_BACKEND_TOKEN` is set,
`/api` requests must also send `Authorization: Bearer <token>` (or `X-LifeOps-Token`). The MONDAY app's
server sends both; the browser never calls this service directly.

`POST /api/actions/{id}/execute` optionally takes `{"provider", "external_id", "result"}`: the caller
already carried out the approved action (the MONDAY app writes calendar blocks to the user's calendar
and saves drafts) and the service records the outcome instead of running its mock adapters.

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
