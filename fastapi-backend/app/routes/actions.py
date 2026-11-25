import logging

from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy import case, update
from sqlalchemy.orm.attributes import set_committed_value
from sqlmodel import Session, select

from app.core.security import current_owner
from app.db.session import get_session
from app.models import ActionProposal, ActionStatus
from app.schemas import ExternalExecution
from app.services.action_executor import (
    execute_action,
    execution_values,
    record_external_execution,
)
from app.services.safety import can_auto_execute

router = APIRouter(prefix="/api/actions", tags=["actions"])
logger = logging.getLogger(__name__)

# Statuses from which each step may start. Every change of an action's status is a conditional
# UPDATE on these, so of two requests that overlap (a Reject while a Run is being recorded, two
# Runs from two tabs) only one wins; the other gets an answer instead of overwriting the first.
_APPROVABLE = {ActionStatus.pending, ActionStatus.approved, ActionStatus.failed}
_REJECTABLE = {ActionStatus.pending, ActionStatus.approved, ActionStatus.failed, ActionStatus.rejected}

_CHANGED_MEANWHILE = "This action was changed by another request at the same time; reload and try again"


def action_order():
    """Actions that need the user first (pending, approved, then failed ones), then the finished
    ones (executed, rejected); newest first within each. Spelled out instead of ORDER BY status,
    whose order depends on the database (see tasks.task_order)."""
    status_rank = case(
        {
            ActionStatus.pending: 0,
            ActionStatus.approved: 1,
            ActionStatus.failed: 2,
            ActionStatus.executed: 3,
            ActionStatus.rejected: 4,
        },
        value=ActionProposal.status,
        else_=5,
    )
    return (status_rank, ActionProposal.created_at.desc(), ActionProposal.id.desc())


def _owned_action(session: Session, action_id: int, owner: str) -> ActionProposal:
    action = session.get(ActionProposal, action_id, populate_existing=True)
    if not action or action.owner != owner:
        raise HTTPException(status_code=404, detail="Action not found")
    return action


def _transition(session: Session, action: ActionProposal, allowed_from: set[ActionStatus], values: dict) -> bool:
    """Write `values` only if the stored status is still one of `allowed_from`, and commit.

    Returns False (and rolls back) when another request changed the status in the meantime.
    """
    if not values:
        return True
    statement = (
        update(ActionProposal)
        .where(
            ActionProposal.id == action.id,
            ActionProposal.owner == action.owner,
            ActionProposal.status.in_(sorted(allowed_from)),
        )
        .values(**values)
        .execution_options(synchronize_session=False)
    )
    if session.exec(statement).rowcount != 1:
        session.rollback()
        return False
    session.commit()
    for key, value in values.items():
        set_committed_value(action, key, value)
    return True


def _log_unrecorded_run(action_id: int | None, result: dict) -> None:
    """Log an adapter run whose outcome was not stored because another request changed the action
    first. The adapter has already run by then (with Zapier, an outside write may exist), so the
    provider and external id are kept in the log instead of being lost without a trace."""
    logger.warning(
        "Action %s was changed by another request while it ran, so this run was not recorded "
        "(status %s, provider %s, external id %s).",
        action_id,
        result.get("status"),
        result.get("provider"),
        result.get("external_id"),
    )


def _already_executed_response(action: ActionProposal, outcome: ExternalExecution | None) -> dict:
    """A second /execute of an executed action leaves the stored outcome as it is.

    Without a body, or with the same provider and external id (a retry after a lost answer), it
    answers with the stored outcome. A different outcome means the caller carried the action out a
    second time; that is refused, so the caller knows its second result was not recorded.
    """
    if outcome is not None and (outcome.provider, outcome.external_id) != (action.provider, action.external_id):
        raise HTTPException(
            status_code=409,
            detail="This action was already carried out, so this second result was not recorded",
        )
    return {
        "action_id": action.id,
        "status": action.status,
        "provider": action.provider,
        "external_id": action.external_id,
        "result": {"status": "already_executed", "provider": action.provider, "external_id": action.external_id},
    }


@router.get("")
def list_actions(session: Session = Depends(get_session), owner: str = Depends(current_owner)):
    statement = select(ActionProposal).where(ActionProposal.owner == owner).order_by(*action_order())
    return session.exec(statement).all()


@router.get("/{action_id}")
def get_action(action_id: int, session: Session = Depends(get_session), owner: str = Depends(current_owner)):
    return _owned_action(session, action_id, owner)


@router.post("/{action_id}/approve")
def approve_action(action_id: int, session: Session = Depends(get_session), owner: str = Depends(current_owner)):
    action = _owned_action(session, action_id, owner)
    if action.status not in _APPROVABLE:
        raise HTTPException(status_code=400, detail=f"Action is already {action.status.value}")

    if not _transition(session, action, _APPROVABLE, {"status": ActionStatus.approved}):
        current = _owned_action(session, action_id, owner)
        if current.status not in _APPROVABLE:
            raise HTTPException(status_code=400, detail=f"Action is already {current.status.value}")
        raise HTTPException(status_code=409, detail=_CHANGED_MEANWHILE)
    return action


@router.post("/{action_id}/reject")
def reject_action(action_id: int, session: Session = Depends(get_session), owner: str = Depends(current_owner)):
    action = _owned_action(session, action_id, owner)
    if action.status == ActionStatus.executed:
        raise HTTPException(status_code=400, detail="Executed actions cannot be rejected")

    if not _transition(session, action, _REJECTABLE, {"status": ActionStatus.rejected}):
        current = _owned_action(session, action_id, owner)
        if current.status == ActionStatus.executed:
            raise HTTPException(status_code=400, detail="Executed actions cannot be rejected")
        raise HTTPException(status_code=409, detail=_CHANGED_MEANWHILE)
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

    # Checked first: an executed action that needed approval is no longer "approved", and the
    # approval check below would wrongly answer that it still needs approval.
    if action.status == ActionStatus.executed:
        return _already_executed_response(action, outcome)

    if action.status == ActionStatus.rejected:
        raise HTTPException(status_code=400, detail="Rejected action cannot be executed")

    if action.requires_approval and action.status != ActionStatus.approved:
        raise HTTPException(
            status_code=400,
            detail="This action requires approval before execution",
        )

    allowed_from = {ActionStatus.approved} if action.requires_approval else set(_APPROVABLE)
    if outcome is not None:
        result = record_external_execution(action, outcome.provider, outcome.external_id, outcome.result)
    else:
        result = execute_action(action)

    if not _transition(session, action, allowed_from, execution_values(result)):
        if outcome is None:
            # The built-in or Zapier adapter ran before the conditional write lost.
            _log_unrecorded_run(action_id, result)
        current = _owned_action(session, action_id, owner)
        if current.status == ActionStatus.rejected:
            detail = "This action was rejected while it was being run, so its result was not recorded"
        elif current.status == ActionStatus.executed:
            detail = "This action was carried out by another request at the same time, so this result was not recorded"
        else:
            detail = _CHANGED_MEANWHILE
        raise HTTPException(status_code=409, detail=detail)

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
    failed = []
    skipped = []

    for action in actions:
        # Only low-risk actions that do not need a human decision run automatically.
        if can_auto_execute(action) and not action.requires_approval:
            result = execute_action(action)
            changed = session.exec(
                update(ActionProposal)
                .where(ActionProposal.id == action.id, ActionProposal.status == ActionStatus.pending)
                .values(**execution_values(result))
                .execution_options(synchronize_session=False)
            ).rowcount
            if changed != 1:
                # Approved, rejected or run by another request meanwhile: left as that request set it.
                _log_unrecorded_run(action.id, result)
                skipped.append({"action_id": action.id, "reason": "changed_meanwhile"})
            elif result.get("status") == "executed":
                executed.append({"action_id": action.id, "result": result})
            else:
                # Stored as failed (for example Zapier unreachable): it ran, but nothing was done,
                # so it is not counted as executed.
                failed.append({"action_id": action.id, "result": result})
        else:
            skipped.append({"action_id": action.id, "reason": "not_safe_for_auto_execution"})

    session.commit()

    return {
        "executed_count": len(executed),
        "failed_count": len(failed),
        "skipped_count": len(skipped),
        "executed": executed,
        "failed": failed,
        "skipped": skipped,
    }
