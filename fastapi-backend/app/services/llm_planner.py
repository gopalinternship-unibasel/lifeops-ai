import json
import logging
import math
import re
from datetime import datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from openai import APIConnectionError, APIStatusError, APITimeoutError, OpenAI
from pydantic import ValidationError

from app.core.config import settings
from app.schemas import PlannerAction, PlannerOutput, PlannerTask
from app.services.demo_planner import build_demo_plan

logger = logging.getLogger(__name__)

# Below this many seconds left before the caller's deadline the model is not asked at all.
_MIN_MODEL_SECONDS = 1.0
# Seconds kept back from the caller's deadline for storing the plan and answering.
_DEADLINE_MARGIN_SECONDS = 2.0


class PlannerAnswerError(ValueError):
    """A model answer the planner cannot use. The message is written for the user: it goes into
    the plan's note ("The AI model could not make this plan (<message>) ...")."""


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
- Day names ("Thursday", "tomorrow") are the dates in the "Dates" list of the request; use that list, do not count days yourself.
- When the input names a time for something ("gym tomorrow at 6 pm for an hour", "block Thursday 2-4 pm"), add a "calendar_block" action with start_time and end_time on that date. end_time is after start_time: the stated length, else 60 minutes.
- A "reminder" has only a start_time (end_time null). A "task" has no start_time; put its due date in the task's "deadline".
- If the date is vague, make a reasonable schedule and explain it in the description.
- Do not send emails.
- Email actions must only be drafts.
- High-risk actions require approval.
- Low-risk calendar blocks, reminders, tasks, and drafts can be marked requires_approval=false.
- Priorities: 5 = most important, 1 = least important.
- Keep it short: at most 5 tasks and 5 actions.
"""

def upcoming_dates(now: datetime, days: int = 8) -> str:
    """ "Monday 2026-11-09 (today), Tuesday 2026-11-10 (tomorrow), ..." for the request: a small
    model put "Thursday" on a Tuesday when it had to count days itself (QA round 3)."""
    labels = []
    for offset in range(days):
        day = (now + timedelta(days=offset)).date()
        suffix = " (today)" if offset == 0 else " (tomorrow)" if offset == 1 else ""
        labels.append(f"{day.strftime('%A')} {day.isoformat()}{suffix}")
    return ", ".join(labels)


_FENCE_RE = re.compile(r"^\s*```(?:json)?\s*|\s*```\s*$", re.IGNORECASE)
_ACTION_TYPES = {"task", "calendar_block", "email_draft", "reminder"}
_RISK_LEVELS = {"low", "medium", "high"}


def _extract_json(raw: str) -> dict[str, Any]:
    """The JSON object in a model's text answer: code fences are stripped and, when the text
    holds more than the object (prose before or after it), the first JSON object is taken."""
    text = _FENCE_RE.sub("", raw or "").strip()
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        start = text.find("{")
        if start < 0:
            raise
        try:
            data, _ = json.JSONDecoder().raw_decode(text, start)
        except json.JSONDecodeError:
            end = text.rfind("}")
            if end <= start:
                raise
            data = json.loads(text[start : end + 1])
    if not isinstance(data, dict):
        raise PlannerAnswerError("the model's answer was not a readable plan")
    return data


def _wall_clock(value: datetime | None) -> datetime | None:
    """Planned times are the user's local wall-clock time (the prompt says so). Small models
    still append "Z" or an offset now and then; keep the wall time and drop the offset, so a
    block asked for at 18:00 lands at 18:00 local, whatever database stores it."""
    return value.replace(tzinfo=None) if value is not None and value.tzinfo is not None else value


_ADDRESS = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+")


def recipient_from_user(value: str, user_input: str) -> str | None:
    """The recipient the model wrote, if the user wrote it; otherwise None.

    Every email address in it must be an address of the user's text ("Sam <sam@uni.example>" is
    kept when the text has sam@uni.example), and a recipient without an address must be a name
    the text contains as a word ("Sam"). An address the model made up never passes.
    """
    recipient = " ".join((value or "").split())
    text = (user_input or "").lower()
    addresses = [address.lower() for address in _ADDRESS.findall(recipient)]
    if addresses:
        written = {address.lower() for address in _ADDRESS.findall(text)}
        return recipient if all(address in written for address in addresses) else None
    if "@" in recipient or len(recipient) < 2:
        return None
    return recipient if re.search(rf"(?<!\w){re.escape(recipient.lower())}(?!\w)", text) else None


# Longest texts kept from a model answer. The MONDAY app copies an action's title and description
# into a calendar entry (title up to 200, notes up to 2000 characters) and a draft (subject 300,
# body 12000, recipient 320); longer values would be refused there.
_TITLE_MAX = 200
_DESCRIPTION_MAX = 2000
_SUBJECT_MAX = 300
_BODY_MAX = 12000
_RECIPIENT_MAX = 320
_SUMMARY_MAX = 1000
_STEP_MAX = 300
_DATE_ONLY = re.compile(r"^\s*(\d{4}-\d{2}-\d{2})\s*$")


def _number(value: Any, default: int, low: int, high: int) -> int:
    """A whole number from a model's value, clamped to [low, high].

    Models write 4, 4.7, "4.5", "0" or null; int() truncated 4.7 to 4, sent "4.5" and a falsy 0 to
    the default, and let 10**12 minutes through (the column is a 32-bit integer on PostgreSQL).
    Halves round up; values beyond a bound (infinity included) are clamped to it. Missing, empty,
    boolean and unreadable values, and NaN, give the default.
    """
    if value is None or isinstance(value, bool) or (isinstance(value, str) and not value.strip()):
        return default
    try:
        number = float(value)
    except OverflowError:  # an integer with hundreds of digits
        number = math.inf if value > 0 else -math.inf
    except (TypeError, ValueError):
        return default
    if math.isnan(number):
        return default
    return math.floor(min(high, max(low, number)) + 0.5)


def _text(value: Any, limit: int) -> str | None:
    """A stripped, length-capped text, or None for a missing or blank value."""
    if value is None:
        return None
    text = str(value).strip()
    return text[:limit] if text else None


def sanitize_plan(data: dict[str, Any], user_input: str = "") -> tuple[PlannerOutput, list[str]]:
    """Validate a model answer item by item, so one bad entry does not discard the plan.

    Safety rules enforced here, whatever the model said:
    - unknown action types are dropped (there is no "send email" action at all);
    - calendar blocks need a start and an end, and must end after they start;
    - medium/high risk actions always require human approval, and so does an action whose
      requires_approval is missing or not a true/false value;
    - an email address is kept only if the user wrote it: the planner knows no address book, and
      the model invented "sam@example.com" for "draft an email to Sam" (QA round 4), which the app
      then saved as the draft's recipient.
    Common model quirks are repaired instead of dropping the item: "" for a time or text, null for
    requires_approval, numbers as text, a single string as the execution order.
    """
    notes: list[str] = []
    had_offsets = False
    tasks: list[PlannerTask] = []
    for raw_task in data.get("tasks") or []:
        if not isinstance(raw_task, dict):
            continue
        candidate = dict(raw_task)
        title = _text(candidate.get("title"), _TITLE_MAX)
        if not title:
            notes.append("Dropped a task without a title.")
            continue
        candidate["title"] = title
        candidate["description"] = _text(candidate.get("description"), _DESCRIPTION_MAX)
        candidate["priority"] = _number(candidate.get("priority"), 3, 1, 5)
        candidate["estimated_minutes"] = _number(candidate.get("estimated_minutes"), 60, 5, 1440)
        deadline = candidate.get("deadline")
        if isinstance(deadline, str):
            if not deadline.strip():
                candidate["deadline"] = None
            elif match := _DATE_ONLY.match(deadline):
                # A date without a time means "by the end of that day", not its first minute.
                candidate["deadline"] = f"{match.group(1)}T23:59:00"
        try:
            tasks.append(PlannerTask.model_validate(candidate))
        except ValidationError:
            candidate.pop("deadline", None)
            try:
                tasks.append(PlannerTask.model_validate(candidate))
                notes.append(f"Ignored an unreadable deadline on task '{title}'.")
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
        title = _text(candidate.get("title"), _TITLE_MAX)
        if not title:
            notes.append(f"Dropped a {action_type.replace('_', ' ')} without a title.")
            continue
        candidate["title"] = title
        # "" (or blanks) for an optional field means "none"; pydantic rejected "" as a time and
        # dropped the whole action.
        for key, limit in (
            ("description", _DESCRIPTION_MAX),
            ("email_to", _RECIPIENT_MAX),
            ("email_subject", _SUBJECT_MAX),
            ("email_body", _BODY_MAX),
        ):
            candidate[key] = _text(candidate.get(key), limit)
        for key in ("start_time", "end_time"):
            value = candidate.get(key)
            if value is None or (isinstance(value, str) and not value.strip()):
                candidate[key] = None
        risk = str(candidate.get("risk_level") or "low").strip().lower()
        candidate["risk_level"] = risk if risk in _RISK_LEVELS else "medium"
        if candidate["risk_level"] != "low" or not isinstance(candidate.get("requires_approval"), bool):
            candidate["requires_approval"] = True
        try:
            action = PlannerAction.model_validate(candidate)
        except ValidationError:
            notes.append(f"Dropped action '{title}' with invalid fields.")
            continue
        # Before comparing: a naive and an offset time cannot be compared.
        had_offsets |= any(t is not None and t.tzinfo is not None for t in (action.start_time, action.end_time))
        action.start_time = _wall_clock(action.start_time)
        action.end_time = _wall_clock(action.end_time)
        if action.action_type == "calendar_block":
            if not action.start_time or not action.end_time or action.end_time <= action.start_time:
                notes.append(f"Dropped calendar block '{action.title}' without a valid time range.")
                continue
        elif action.end_time is not None and (action.start_time is None or action.end_time <= action.start_time):
            # A reminder or task is a point in time: "17:45 - 17:45" is not a range.
            action.end_time = None
        if action.email_to:
            written = action.email_to.strip()
            action.email_to = recipient_from_user(written, user_input) if action.action_type == "email_draft" else None
            if action.email_to is None and action.action_type == "email_draft":
                # The MONDAY approval center has a To field for this, filled in before Run.
                notes.append(
                    f"Left the recipient of '{action.title}' empty: the model wrote '{written[:80]}', "
                    "which is not in your text. Type the recipient in the To field before you run the draft."
                )
        actions.append(action)

    if had_offsets:
        notes.append("Read the model's times as local times (ignored a time zone offset).")

    summary = _text(data.get("summary"), _SUMMARY_MAX) or "Here is your plan."
    raw_order = data.get("execution_order")
    if isinstance(raw_order, str):
        raw_order = [raw_order]  # one step as text; iterating it gave one step per character
    elif not isinstance(raw_order, list):
        raw_order = []
    order = [step for step in (_text(item, _STEP_MAX) for item in raw_order if item is not None) if step]
    if not tasks and not actions:
        raise PlannerAnswerError("the model returned no usable tasks or actions")
    return PlannerOutput(summary=summary, tasks=tasks, actions=actions, execution_order=order), notes


def _extra_body() -> dict[str, Any] | None:
    """LLM_EXTRA_BODY as a dict, or None when it is unset or not a JSON object."""
    text = (settings.llm_extra_body or "").strip()
    if not text:
        return None
    try:
        parsed = json.loads(text)
    except ValueError:
        return None
    return parsed if isinstance(parsed, dict) else None


def _response_format() -> dict[str, Any] | None:
    """The response_format of the request, or None to send none (LLM_RESPONSE_FORMAT=none)."""
    mode = (settings.llm_response_format or "").strip().lower()
    if mode == "none":
        return None
    if mode == "json_object":
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


def readable_failure(error: Exception, timeout_seconds: float | None = None) -> str:
    """One readable phrase for a failed model call, for the plan's note.

    Only fixed wording reaches the user: the provider's raw JSON body, parser messages ("Expecting
    ',' delimiter: line 1 column 40") and Python errors ("list index out of range") stay in the log.
    """
    if isinstance(error, PlannerAnswerError):
        return str(error)
    if isinstance(error, APITimeoutError):
        seconds = settings.llm_timeout_seconds if timeout_seconds is None else timeout_seconds
        return f"the model did not answer within {seconds:.0f} s"
    if isinstance(error, APIStatusError):
        detail = _error_text(error.body)
        line = " ".join(detail.split())[:160] if detail else ""
        if line.startswith(("{", "[", "<")):
            line = ""
        return f"the model service answered HTTP {error.status_code}" + (f": {line}" if line else "")
    if isinstance(error, APIConnectionError):
        return "the model service could not be reached"
    if isinstance(error, ValueError):  # JSON and validation errors are ValueErrors too
        return "the model's answer was not a readable plan"
    return "the model call failed"


_ZONE_NAME = re.compile(r"^[A-Za-z0-9_+-]+(?:/[A-Za-z0-9_+-]+)*$")


def _zone_name(timezone: str | None) -> str | None:
    """The caller's IANA zone name if it looks like one (it is also written into the prompt)."""
    name = (timezone or "").strip()
    return name if name and _ZONE_NAME.match(name) else None


def _zone(timezone: str | None) -> ZoneInfo | None:
    name = _zone_name(timezone)
    if name is None:
        return None
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError, OSError):
        # An unknown zone, or no time zone data on this host: read times without a zone. Logged,
        # because on a host without zone data every request would quietly use the server clock.
        logger.warning("Time zone %r is unknown here; the caller's times are read without a zone.", name)
        return None


def local_now(now: datetime | None, timezone: str | None) -> datetime:
    """The caller's current local wall-clock time, naive, as both planners and the prompt use it.

    - A naive `now` is the caller's own wall-clock time (what the MONDAY app sends): unchanged.
    - An aware `now` is converted to the caller's zone (or keeps its own offset's wall time when
      the zone is unknown) and loses the offset. Before, the offset went on into the keyword
      planner's times, and PostgreSQL stored 10:00+01:00 as 09:00 in the naive columns.
    - Without `now`, the current time in the caller's zone; only without a usable zone the
      server's clock (UTC on Vercel, which was labelled as the caller's zone before).
    """
    zone = _zone(timezone)
    if now is None:
        return datetime.now(zone).replace(tzinfo=None) if zone else datetime.now()
    if now.tzinfo is not None:
        return (now.astimezone(zone) if zone else now).replace(tzinfo=None)
    return now


def create_plan(
    user_input: str,
    now: datetime | None = None,
    timezone: str | None = None,
    time_budget: float | None = None,
) -> tuple[PlannerOutput, str, str | None]:
    """Return (plan, planner, note). planner is "llm" or "demo".

    `time_budget` is the number of seconds until the caller stops waiting (None: no limit); the
    model call is given at most that time minus a small margin. The note is shown to the user.
    """
    caller_wall_clock = now is not None and now.tzinfo is None
    local = local_now(now, timezone)
    endpoint = settings.llm_endpoint()
    if endpoint is None:
        logger.info("No LLM configured (LLM_BASE_URL unset or PLANNER_MODE=keyword): keyword planner used.")
        return (
            build_demo_plan(user_input, local),
            "demo",
            "No AI model is set up for the planner, so the keyword planner made this plan.",
        )

    timeout = settings.llm_timeout_seconds
    if time_budget is not None:
        timeout = min(timeout, time_budget - _DEADLINE_MARGIN_SECONDS)
        if timeout < _MIN_MODEL_SECONDS:
            logger.info("No time left for the model before the caller's deadline: keyword planner used.")
            return (
                build_demo_plan(user_input, local),
                "demo",
                "There was no time left to ask the AI model, so the keyword planner made this plan.",
            )

    base_url, api_key, model = endpoint
    # The zone label is true when the time is the caller's own wall clock or was converted to the
    # zone; a server-clock time is not labelled with the caller's zone.
    zone_name = _zone_name(timezone)
    zone = f" ({zone_name})" if zone_name and (caller_wall_clock or _zone(timezone)) else ""
    try:
        client = OpenAI(
            base_url=base_url,
            api_key=api_key or "not-needed",
            timeout=timeout,
            max_retries=0,
        )
        response_format = _response_format()
        # With LLM_RESPONSE_FORMAT=none the key is left out; the prompt asks for JSON and
        # _extract_json reads it from the text.
        extra: dict[str, Any] = {"response_format": response_format} if response_format else {}
        extra_body = _extra_body()
        if extra_body:
            extra["extra_body"] = extra_body
        response = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {
                    "role": "user",
                    "content": (
                        f"Current local datetime{zone}: {local.replace(microsecond=0).isoformat()}\n"
                        f"Dates: {upcoming_dates(local)}\n\n"
                        f"User input:\n{user_input}"
                    ),
                },
            ],
            temperature=0.2,
            max_tokens=settings.llm_max_tokens,
            **extra,
        )
        plan, notes = sanitize_plan(_read_answer(response), user_input)
        return plan, "llm", " ".join(notes) or None
    except Exception as error:  # noqa: BLE001 - any failure falls back so the demo stays alive
        logger.warning("LLM planner failed, using the keyword planner: %r", error)
        reason = readable_failure(error, timeout)
        return (
            build_demo_plan(user_input, local),
            "demo",
            f"The AI model could not make this plan ({reason}), so the keyword planner made it instead.",
        )


def _read_answer(response: Any) -> dict[str, Any]:
    """The plan object in a chat completion, or a PlannerAnswerError that says what was wrong."""
    choices = getattr(response, "choices", None) or []
    if not choices:
        raise PlannerAnswerError("the model returned an empty answer")
    choice = choices[0]
    cut_off = getattr(choice, "finish_reason", None) == "length"
    message = getattr(choice, "message", None)
    raw = (getattr(message, "content", None) or "").strip()
    if not raw:
        if cut_off:
            # Seen with a thinking model: the whole token budget went into thinking.
            raise PlannerAnswerError("the model used up its length limit before it answered")
        raise PlannerAnswerError("the model returned an empty answer")
    try:
        return _extract_json(raw)
    except PlannerAnswerError:
        raise
    except ValueError:
        if cut_off:
            raise PlannerAnswerError("the model's answer was cut off at its length limit") from None
        raise PlannerAnswerError("the model's answer was not a readable plan") from None
