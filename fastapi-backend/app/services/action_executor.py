from app.core.config import settings
from app.integrations.zapier_mcp import execute_with_zapier_mcp


from datetime import datetime
import json

from app.integrations.gmail import create_gmail_draft
from app.integrations.google_calendar import create_calendar_event
from app.models import ActionProposal, ActionStatus, ActionType


def execute_action(action: ActionProposal) -> dict:
    
    
    if action.status == ActionStatus.executed:
        return {
            "status": "already_executed",
            "provider": action.provider,
            "external_id": action.external_id,
        }
    
    if settings.execution_backend == "zapier_mcp":
        return execute_with_zapier_mcp(action)
    

    if action.action_type == ActionType.calendar_block:
        result = create_calendar_event(
            title=action.title,
            description=action.description,
            start_time=action.start_time,
            end_time=action.end_time,
        )
        return {
            "status": "executed",
            "provider": "google_calendar",
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
            "provider": "gmail",
            "external_id": result.get("external_id"),
            "result": result,
        }

    if action.action_type == ActionType.reminder:
        result = {
            "mode": "local",
            "message": "Reminder recorded in LifeOps backend.",
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
            "message": "Task action acknowledged.",
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


def apply_execution_result(action: ActionProposal, result: dict) -> ActionProposal:
    if result.get("status") in {"executed", "already_executed"}:
        action.status = ActionStatus.executed
        action.executed_at = datetime.utcnow()
    else:
        action.status = ActionStatus.failed

    action.provider = result.get("provider")
    action.external_id = result.get("external_id")
    action.execution_result = json.dumps(result.get("result", result), default=str)

    return action


def record_external_execution(
    action: ActionProposal,
    provider: str,
    external_id: str | None,
    result: dict | str | None,
) -> dict:
    """Result dict for an approved action the caller carried out itself."""
    if action.status == ActionStatus.executed:
        return {
            "status": "already_executed",
            "provider": action.provider,
            "external_id": action.external_id,
        }
    return {
        "status": "executed",
        "provider": provider,
        "external_id": external_id,
        "result": result if result is not None else {"mode": "external"},
    }
