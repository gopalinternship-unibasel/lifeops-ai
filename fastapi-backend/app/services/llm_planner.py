import json
import logging
import re
from datetime import datetime
from typing import Any

from openai import APIStatusError, APITimeoutError, OpenAI
from pydantic import ValidationError

from app.core.config import settings
from app.schemas import PlannerAction, PlannerOutput, PlannerTask
from app.services.demo_planner import build_demo_plan

logger = logging.getLogger(__name__)

SYSTEM_PROMPT = """
You are LifeOps AI, an agentic operations planner for personal productivity.

Your job:
Convert chaotic user input into an executable plan.

Return strict JSON only.

Schema:
{
  "summary": "short summary",
  "tasks": [
    {
      "title": "string",
      "description": "string or null",
      "deadline": "ISO datetime string or null",
      "estimated_minutes": 60,
      "priority": 1
    }
  ],
  "actions": [
    {
      "action_type": "task | calendar_block | email_draft | reminder",
      "title": "string",
      "description": "string or null",
      "start_time": "ISO datetime string or null",
      "end_time": "ISO datetime string or null",
      "email_to": "email address or null",
      "email_subject": "string or null",
      "email_body": "string or null",
      "risk_level": "low | medium | high",
      "requires_approval": true
    }
  ],
  "execution_order": ["step 1", "step 2"]
}

Rules:
- Use the current datetime given by the backend. Write all times as local times without an offset.
- If the date is vague, make a reasonable schedule and explain it in the description.
- Do not send emails.
- Email actions must only be drafts.
- High-risk actions require approval.
- Low-risk calendar blocks, reminders, tasks, and drafts can be marked requires_approval=false.
- Priorities: 5 = most important, 1 = least important.
- Keep it short: at most 5 tasks and 5 actions.
"""

_FENCE_RE = re.compile(r"^\s*```(?:json)?\s*|\s*```\s*$", re.IGNORECASE)
_ACTION_TYPES = {"task", "calendar_block", "email_draft", "reminder"}
_RISK_LEVELS = {"low", "medium", "high"}


def _extract_json(raw: str) -> dict[str, Any]:
    text = _FENCE_RE.sub("", raw or "").strip()
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        start, end = text.find("{"), text.rfind("}")
        if start < 0 or end <= start:
            raise
        data = json.loads(text[start : end + 1])
    if not isinstance(data, dict):
        raise ValueError("The model did not return a JSON object")
    return data


def _wall_clock(value: datetime | None) -> datetime | None:
    """Planned times are the user's local wall-clock time (the prompt says so). Small models
    still append "Z" or an offset now and then; keep the wall time and drop the offset, so a
    block asked for at 18:00 lands at 18:00 local, whatever database stores it."""
    return value.replace(tzinfo=None) if value is not None and value.tzinfo is not None else value


def sanitize_plan(data: dict[str, Any]) -> tuple[PlannerOutput, list[str]]:
    """Validate a model answer item by item, so one bad entry does not discard the plan.

    Safety rules enforced here, whatever the model said:
    - unknown action types are dropped (there is no "send email" action at all);
    - calendar blocks need a start and an end, and must end after they start;
    - medium/high risk actions always require human approval.
    """
    notes: list[str] = []
    had_offsets = False
    tasks: list[PlannerTask] = []
    for raw_task in data.get("tasks") or []:
        if not isinstance(raw_task, dict):
            continue
        candidate = dict(raw_task)
        try:
            priority = int(candidate.get("priority") or 3)
        except (TypeError, ValueError):
            priority = 3
        candidate["priority"] = min(5, max(1, priority))
        try:
            minutes = int(candidate.get("estimated_minutes") or 60)
        except (TypeError, ValueError):
            minutes = 60
        candidate["estimated_minutes"] = max(5, minutes)
        try:
            tasks.append(PlannerTask.model_validate(candidate))
        except ValidationError:
            candidate.pop("deadline", None)
            try:
                tasks.append(PlannerTask.model_validate(candidate))
                notes.append(f"Ignored an unreadable deadline on task '{candidate.get('title')}'.")
            except ValidationError:
                notes.append("Dropped a task the model returned in an invalid shape.")

    for task in tasks:
        had_offsets |= task.deadline is not None and task.deadline.tzinfo is not None
        task.deadline = _wall_clock(task.deadline)

    actions: list[PlannerAction] = []
    for raw_action in data.get("actions") or []:
        if not isinstance(raw_action, dict):
            continue
        candidate = dict(raw_action)
        action_type = str(candidate.get("action_type") or "").strip().lower()
        if action_type not in _ACTION_TYPES:
            notes.append(f"Dropped unsupported action type '{action_type or '?'}'.")
            continue
        candidate["action_type"] = action_type
        risk = str(candidate.get("risk_level") or "low").strip().lower()
        candidate["risk_level"] = risk if risk in _RISK_LEVELS else "medium"
        if candidate["risk_level"] != "low":
            candidate["requires_approval"] = True
        try:
            action = PlannerAction.model_validate(candidate)
        except ValidationError:
            notes.append(f"Dropped action '{candidate.get('title')}' with invalid fields.")
            continue
        # Before comparing: a naive and an offset time cannot be compared.
        had_offsets |= any(t is not None and t.tzinfo is not None for t in (action.start_time, action.end_time))
        action.start_time = _wall_clock(action.start_time)
        action.end_time = _wall_clock(action.end_time)
        if action.action_type == "calendar_block":
            if not action.start_time or not action.end_time or action.end_time <= action.start_time:
                notes.append(f"Dropped calendar block '{action.title}' without a valid time range.")
                continue
        actions.append(action)

    if had_offsets:
        notes.append("Read the model's times as local times (ignored a time zone offset).")

    summary = str(data.get("summary") or "").strip() or "Here is your plan."
    order = [str(step) for step in (data.get("execution_order") or []) if str(step).strip()]
    if not tasks and not actions:
        raise ValueError("The model returned no usable tasks or actions")
    return PlannerOutput(summary=summary, tasks=tasks, actions=actions, execution_order=order), notes


def _response_format() -> dict[str, Any]:
    if settings.llm_response_format == "json_object":
        return {"type": "json_object"}
    return {
        "type": "json_schema",
        "json_schema": {
            "name": "lifeops_plan",
            "schema": PlannerOutput.model_json_schema(),
        },
    }


def _error_text(body: Any) -> str | None:
    """The first message-like string in a provider's error body ({"error": {"message": ...}})."""
    if isinstance(body, str):
        return body.strip() or None
    if isinstance(body, list) and body:
        return _error_text(body[0])
    if isinstance(body, dict):
        for key in ("message", "error", "detail", "msg"):
            found = _error_text(body.get(key))
            if found:
                return found
    return None


def readable_failure(error: Exception) -> str:
    """One readable line for a failed model call; the provider's raw JSON body never reaches the UI."""
    if isinstance(error, APITimeoutError):
        return f"the model did not answer within {settings.llm_timeout_seconds:g} s"
    if isinstance(error, APIStatusError):
        detail = _error_text(error.body)
        line = " ".join(detail.split())[:160] if detail else ""
        if line.startswith(("{", "[", "<")):
            line = ""
        return f"the model service answered HTTP {error.status_code}" + (f": {line}" if line else "")
    text = str(error).splitlines()[0][:200] if str(error) else type(error).__name__
    return text


def create_plan(
    user_input: str,
    now: datetime | None = None,
    timezone: str | None = None,
) -> tuple[PlannerOutput, str, str | None]:
    """Return (plan, planner, note). planner is "llm" or "demo"."""
    endpoint = settings.llm_endpoint()
    if endpoint is None:
        return build_demo_plan(user_input, now), "demo", "No LLM configured (LLM_BASE_URL unset or PLANNER_MODE=keyword): keyword planner used."

    base_url, api_key, model = endpoint
    now = now or datetime.now()
    zone = f" ({timezone})" if timezone else ""
    try:
        client = OpenAI(
            base_url=base_url,
            api_key=api_key or "not-needed",
            timeout=settings.llm_timeout_seconds,
            max_retries=0,
        )
        response = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {
                    "role": "user",
                    "content": (
                        f"Current local datetime{zone}: {now.replace(microsecond=0).isoformat()}\n\n"
                        f"User input:\n{user_input}"
                    ),
                },
            ],
            response_format=_response_format(),
            temperature=0.2,
            max_tokens=settings.llm_max_tokens,
        )
        raw = response.choices[0].message.content or "{}"
        plan, notes = sanitize_plan(_extract_json(raw))
        return plan, "llm", " ".join(notes) or None
    except Exception as error:  # noqa: BLE001 - any failure falls back so the demo stays alive
        logger.warning("LLM planner failed, using the keyword planner: %s", error)
        reason = readable_failure(error)
        return (
            build_demo_plan(user_input, now),
            "demo",
            f"The LLM planner failed ({reason}); the keyword planner was used instead.",
        )
