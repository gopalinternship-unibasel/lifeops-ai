import json
import logging
from datetime import datetime

from app.core.config import settings
from app.integrations.gmail import create_gmail_draft
from app.integrations.google_calendar import create_calendar_event
from app.integrations.zapier_mcp import execute_with_zapier_mcp
from app.models import ActionProposal, ActionStatus, ActionType

logger = logging.getLogger(__name__)

# Only these two types have a Zapier tool behind them; reminders and tasks stay local.
_ZAPIER_TYPES = {ActionType.calendar_block, ActionType.email_draft}


def _already_executed(action: ActionProposal) -> dict:
    return {
        "status": "already_executed",
        "provider": action.provider,
        "external_id": action.external_id,
    }


def _run_with_zapier(action: ActionProposal) -> dict:
    """The Zapier executor, with its failures as a failed result instead of an exception: a missing
    setting or an unreachable Zapier server must not turn the request into a bare 500 (after the
    plan was stored) or leave the action pending."""
    try:
        return execute_with_zapier_mcp(action)
    except Exception as error:  # noqa: BLE001 - any failure of the outside service fails the action
        # Includes AttributeError: the pinned openai SDK (1.59.7) has no Responses API yet.
        logger.warning("Zapier execution of action %s failed: %r", action.id, error)
        return {
            "status": "failed",
            "provider": "zapier_mcp",
            "external_id": None,
            "result": {"error": "The action could not be sent to Zapier. Check the planner's Zapier settings."},
        }


def execute_action(action: ActionProposal) -> dict:
    if action.status == ActionStatus.executed:
        return _already_executed(action)

    if settings.execution_backend == "zapier_mcp" and action.action_type in _ZAPIER_TYPES:
        return _run_with_zapier(action)

    try:
        return _run_built_in(action)
    except NotImplementedError as error:
        # GOOGLE_INTEGRATION_MODE other than "mock": the Google adapters are placeholders that
        # raise. Fail this action instead of the whole request, which was a bare 500 (and in
        # autonomous mode lost the plan that had just been made).
        logger.warning("Built-in adapter for action %s is not available: %s", action.id, error)
        return {
            "status": "failed",
            "provider": None,
            "external_id": None,
            "result": {"error": "The planner's own Google adapters are not connected; only their stand-in (mock) mode works."},
        }


def _run_built_in(action: ActionProposal) -> dict:
    if action.action_type == ActionType.calendar_block:
        result = create_calendar_event(
            title=action.title,
            description=action.description,
            start_time=action.start_time,
            end_time=action.end_time,
        )
        # The built-in adapter is a stand-in unless GOOGLE_INTEGRATION_MODE says otherwise; the
        # provider name says so, so an execution log does not suggest a Google Calendar write.
        return {
            "status": "executed",
            "provider": "mock_calendar" if result.get("mode") == "mock" else "google_calendar",
            "external_id": result.get("external_id"),
            "result": result,
        }

    if action.action_type == ActionType.email_draft:
        result = create_gmail_draft(
            to=action.email_to,
            subject=action.email_subject,
            body=action.email_body,
        )
        return {
            "status": "executed",
            "provider": "mock_gmail" if result.get("mode") == "mock" else "gmail",
            "external_id": result.get("external_id"),
            "result": result,
        }

    if action.action_type == ActionType.reminder:
        # The planner has no scheduler: say so instead of "Reminder recorded", which read as if
        # something would remind the user.
        result = {
            "mode": "local",
            "message": "Noted only: the planner has no reminder service, so nothing will remind you at this time.",
            "scheduled_for": action.start_time.isoformat() if action.start_time else None,
        }
        return {
            "status": "executed",
            "provider": "lifeops",
            "external_id": None,
            "result": result,
        }

    if action.action_type == ActionType.task:
        result = {
            "mode": "local",
            "message": "Noted only: running a task action does not create or change a task.",
        }
        return {
            "status": "executed",
            "provider": "lifeops",
            "external_id": None,
            "result": result,
        }

    return {
        "status": "failed",
        "provider": None,
        "external_id": None,
        "result": {"error": f"Unsupported action type: {action.action_type}"},
    }


def execution_values(result: dict) -> dict:
    """The column values an execution result writes to its action.

    Empty for "already_executed": that result describes an earlier run, and storing it would
    replace the recorded outcome and move executed_at to now.
    """
    status = result.get("status")
    if status == "already_executed":
        return {}
    values: dict = {
        "status": ActionStatus.executed if status == "executed" else ActionStatus.failed,
        "provider": result.get("provider"),
        "external_id": result.get("external_id"),
        "execution_result": json.dumps(result.get("result", result), default=str),
    }
    if status == "executed":
        values["executed_at"] = datetime.utcnow()
    return values


def apply_execution_result(action: ActionProposal, result: dict) -> ActionProposal:
    for key, value in execution_values(result).items():
        setattr(action, key, value)
    return action


def record_external_execution(
    action: ActionProposal,
    provider: str,
    external_id: str | None,
    result: dict | str | None,
) -> dict:
    """Result dict for an approved action the caller carried out itself."""
    if action.status == ActionStatus.executed:
        return _already_executed(action)
    return {
        "status": "executed",
        "provider": provider,
        "external_id": external_id,
        "result": result if result is not None else {"mode": "external"},
    }
