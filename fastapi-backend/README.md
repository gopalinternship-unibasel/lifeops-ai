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

```bash
cd lifeops_backend
python -m venv .venv

# Windows PowerShell
.venv\Scripts\Activate.ps1

# macOS/Linux
source .venv/bin/activate

pip install -r requirements.txt
uvicorn app.main:app --reload
```

Open:

```text
http://localhost:8000/docs
```

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

If `OPENAI_API_KEY` is not set, the backend uses a deterministic demo planner so the project works immediately.

If `OPENAI_API_KEY` is set, it uses the LLM planner and asks the model for strict JSON.

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
=======
# Bobathon
>>>>>>> 38def9de72ca3748c07c9f6aec1d1157b500f019
