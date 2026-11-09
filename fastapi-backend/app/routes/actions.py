from fastapi import APIRouter, Body, Depends, HTTPException
from sqlmodel import Session, select

from app.core.security import current_owner
from app.db.session import get_session
from app.models import ActionProposal, ActionStatus
from app.schemas import ExternalExecution
from app.services.action_executor import (
    apply_execution_result,
    execute_action,
    record_external_execution,
)
from app.services.safety import can_auto_execute

router = APIRouter(prefix="/api/actions", tags=["actions"])


def _owned_action(session: Session, action_id: int, owner: str) -> ActionProposal:
    action = session.get(ActionProposal, action_id)
    if not action or action.owner != owner:
        raise HTTPException(status_code=404, detail="Action not found")
    return action


@router.get("")
def list_actions(session: Session = Depends(get_session), owner: str = Depends(current_owner)):
    statement = (
        select(ActionProposal)
        .where(ActionProposal.owner == owner)
        .order_by(ActionProposal.status, ActionProposal.created_at.desc())
    )
    return session.exec(statement).all()


@router.get("/{action_id}")
def get_action(action_id: int, session: Session = Depends(get_session), owner: str = Depends(current_owner)):
    return _owned_action(session, action_id, owner)


@router.post("/{action_id}/approve")
def approve_action(action_id: int, session: Session = Depends(get_session), owner: str = Depends(current_owner)):
    action = _owned_action(session, action_id, owner)
    if action.status in {ActionStatus.executed, ActionStatus.rejected}:
        raise HTTPException(status_code=400, detail=f"Action is already {action.status.value}")

    action.status = ActionStatus.approved
    session.add(action)
    session.commit()
    session.refresh(action)
    return action


@router.post("/{action_id}/reject")
def reject_action(action_id: int, session: Session = Depends(get_session), owner: str = Depends(current_owner)):
    action = _owned_action(session, action_id, owner)
    if action.status == ActionStatus.executed:
        raise HTTPException(status_code=400, detail="Executed actions cannot be rejected")

    action.status = ActionStatus.rejected
    session.add(action)
    session.commit()
    session.refresh(action)
    return action


@router.post("/{action_id}/execute")
def execute_single_action(
    action_id: int,
    outcome: ExternalExecution | None = Body(default=None),
    session: Session = Depends(get_session),
    owner: str = Depends(current_owner),
):
    """Execute an action.

    Without a body the built-in adapters run (mock Gmail and Calendar by default). With a
    body, the caller already carried out the approved action itself (for example the MONDAY
    app wrote the calendar block) and the backend records that outcome.
    """
    action = _owned_action(session, action_id, owner)

    if action.status == ActionStatus.rejected:
        raise HTTPException(status_code=400, detail="Rejected action cannot be executed")

    if action.requires_approval and action.status != ActionStatus.approved:
        raise HTTPException(
            status_code=400,
            detail="This action requires approval before execution",
        )

    if outcome is not None:
        result = record_external_execution(action, outcome.provider, outcome.external_id, outcome.result)
    else:
        result = execute_action(action)
    action = apply_execution_result(action, result)

    session.add(action)
    session.commit()
    session.refresh(action)

    return {
        "action_id": action.id,
        "status": action.status,
        "provider": action.provider,
        "external_id": action.external_id,
        "result": result,
    }


@router.post("/execute-safe")
def execute_all_safe_actions(session: Session = Depends(get_session), owner: str = Depends(current_owner)):
    statement = select(ActionProposal).where(
        ActionProposal.status == ActionStatus.pending,
        ActionProposal.owner == owner,
    )
    actions = session.exec(statement).all()

    executed = []
    skipped = []

    for action in actions:
        # Only low-risk actions that do not need a human decision run automatically.
        if can_auto_execute(action) and not action.requires_approval:
            result = execute_action(action)
            action = apply_execution_result(action, result)
            session.add(action)
            executed.append({"action_id": action.id, "result": result})
        else:
            skipped.append({"action_id": action.id, "reason": "not_safe_for_auto_execution"})

    session.commit()

    return {
        "executed_count": len(executed),
        "skipped_count": len(skipped),
        "executed": executed,
        "skipped": skipped,
    }
