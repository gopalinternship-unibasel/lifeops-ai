from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select

from app.db.session import get_session
from app.models import ActionProposal, ActionStatus
from app.services.action_executor import apply_execution_result, execute_action
from app.services.safety import can_auto_execute

router = APIRouter(prefix="/api/actions", tags=["actions"])


@router.get("")
def list_actions(session: Session = Depends(get_session)):
    statement = select(ActionProposal).order_by(
        ActionProposal.status,
        ActionProposal.created_at.desc(),
    )
    return session.exec(statement).all()


@router.get("/{action_id}")
def get_action(action_id: int, session: Session = Depends(get_session)):
    action = session.get(ActionProposal, action_id)
    if not action:
        raise HTTPException(status_code=404, detail="Action not found")
    return action


@router.post("/{action_id}/approve")
def approve_action(action_id: int, session: Session = Depends(get_session)):
    action = session.get(ActionProposal, action_id)
    if not action:
        raise HTTPException(status_code=404, detail="Action not found")

    action.status = ActionStatus.approved
    session.add(action)
    session.commit()
    session.refresh(action)
    return action


@router.post("/{action_id}/reject")
def reject_action(action_id: int, session: Session = Depends(get_session)):
    action = session.get(ActionProposal, action_id)
    if not action:
        raise HTTPException(status_code=404, detail="Action not found")

    action.status = ActionStatus.rejected
    session.add(action)
    session.commit()
    session.refresh(action)
    return action


@router.post("/{action_id}/execute")
def execute_single_action(action_id: int, session: Session = Depends(get_session)):
    action = session.get(ActionProposal, action_id)
    if not action:
        raise HTTPException(status_code=404, detail="Action not found")

    if action.status == ActionStatus.rejected:
        raise HTTPException(status_code=400, detail="Rejected action cannot be executed")

    if action.requires_approval and action.status != ActionStatus.approved:
        raise HTTPException(
            status_code=400,
            detail="This action requires approval before execution",
        )

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
def execute_all_safe_actions(session: Session = Depends(get_session)):
    statement = select(ActionProposal).where(ActionProposal.status == ActionStatus.pending)
    actions = session.exec(statement).all()

    executed = []
    skipped = []

    for action in actions:
        if can_auto_execute(action):
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
