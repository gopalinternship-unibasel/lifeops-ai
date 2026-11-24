import hashlib
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import delete
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, select

from app.core.security import current_owner
from app.db.session import get_session
from app.models import ActionProposal, ActionStatus, PlanIdempotencyKey, PlanRun, Task
from app.routes.settings import get_or_create_settings
from app.schemas import PlanRequest, PlanResponse
from app.services.action_executor import apply_execution_result, execute_action
from app.services.busy_slots import deadline_passed, keep_clear_of_busy
from app.services.llm_planner import create_plan, local_now
from app.services.safety import can_auto_execute, requires_human_approval

router = APIRouter(prefix="/api", tags=["plan"])

# How long a stored answer for an idempotency key is kept: enough for a client's retries.
IDEMPOTENCY_KEY_DAYS = 2

_LATE = "The plan was ready only after the caller's deadline; nothing was stored."


def _input_sha256(user_input: str) -> str:
    return hashlib.sha256(user_input.encode("utf-8")).hexdigest()


def _stored_answer(session: Session, owner: str, payload: PlanRequest) -> PlanResponse | None:
    """The answer stored for this request's idempotency key, if a request with it already ran."""
    if not payload.idempotency_key:
        return None
    row = session.exec(
        select(PlanIdempotencyKey).where(
            PlanIdempotencyKey.owner == owner,
            PlanIdempotencyKey.idempotency_key == payload.idempotency_key,
        )
    ).first()
    if row is None:
        return None
    if row.input_sha256 != _input_sha256(payload.user_input):
        raise HTTPException(status_code=409, detail="This request id was already used for a different text")
    return PlanResponse.model_validate_json(row.response_json)


def _seconds_left(deadline: datetime | None) -> float | None:
    if deadline is None:
        return None
    if deadline.tzinfo is None:
        deadline = deadline.replace(tzinfo=timezone.utc)
    return (deadline - datetime.now(timezone.utc)).total_seconds()


@router.post("/plan", response_model=PlanResponse)
def create_lifeops_plan(
    payload: PlanRequest,
    session: Session = Depends(get_session),
    owner: str = Depends(current_owner),
):
    """Plan the user's text and store the plan run, its tasks and its proposed actions.

    Everything after the model call is written in one transaction: a failure part way leaves
    nothing behind (before, the plan run and earlier actions stayed while the caller got a 500).
    """
    stored = _stored_answer(session, owner, payload)
    if stored is not None:
        return stored

    # Read (or create) the owner's settings before the model call, so a database problem cannot
    # waste a model call, then end the transaction: no connection is held while the model works.
    stored_autonomous_mode = get_or_create_settings(session, owner).autonomous_mode
    session.commit()

    # The caller stops waiting at its deadline and then plans without this service (the MONDAY
    # app uses its in-app assistant). A plan stored after that would be a second set of
    # proposals for the same request, so a late plan is not stored, and the model is not even
    # asked once the deadline has passed.
    if deadline_passed(payload.deadline):
        raise HTTPException(status_code=504, detail=_LATE)
    plan, planner, planner_note = create_plan(
        payload.user_input,
        now=payload.current_datetime,
        timezone=payload.timezone,
        time_budget=_seconds_left(payload.deadline),
    )
    if deadline_passed(payload.deadline):
        raise HTTPException(status_code=504, detail=_LATE)
    plan, busy_note = keep_clear_of_busy(plan, payload.busy, local_now(payload.current_datetime, payload.timezone))
    planner_note = " ".join(note for note in (planner_note, busy_note) if note) or None

    # An explicit false switches autonomous mode off for this request; only a missing value
    # falls back to the stored setting.
    effective_autonomous_mode = (
        payload.autonomous_mode if payload.autonomous_mode is not None else stored_autonomous_mode
    )

    plan_run = PlanRun(
        owner=owner,
        user_input=payload.user_input,
        summary=plan.summary,
        autonomous_mode_used=effective_autonomous_mode,
        planner=planner,
    )
    session.add(plan_run)
    session.flush()  # assigns plan_run.id for the tasks' source; committed below with the rest

    for item in plan.tasks:
        session.add(
            Task(
                owner=owner,
                title=item.title,
                description=item.description,
                deadline=item.deadline,
                estimated_minutes=item.estimated_minutes,
                priority=item.priority,
                source=f"plan_run:{plan_run.id}",
            )
        )

    executed_safe_actions = 0
    for item in plan.actions:
        approval_required = item.requires_approval or requires_human_approval(
            item.action_type,
            item.risk_level,
        )

        action = ActionProposal(
            owner=owner,
            action_type=item.action_type,
            title=item.title,
            description=item.description,
            start_time=item.start_time,
            end_time=item.end_time,
            email_to=item.email_to,
            email_subject=item.email_subject,
            email_body=item.email_body,
            risk_level=item.risk_level,
            requires_approval=approval_required,
        )
        session.add(action)

        # The same rule as /api/actions/execute-safe: low risk AND no human decision needed.
        if effective_autonomous_mode and can_auto_execute(action) and not action.requires_approval:
            apply_execution_result(action, execute_action(action))
            # Counted only when it ran: an action whose executor failed is stored as failed.
            if action.status == ActionStatus.executed:
                executed_safe_actions += 1

    response = PlanResponse(
        plan_run_id=plan_run.id,
        summary=plan.summary,
        tasks_created=len(plan.tasks),
        actions_created=len(plan.actions),
        executed_safe_actions=executed_safe_actions,
        plan=plan,
        planner=planner,
        planner_note=planner_note,
    )

    if payload.idempotency_key:
        session.exec(
            delete(PlanIdempotencyKey).where(
                PlanIdempotencyKey.created_at < datetime.utcnow() - timedelta(days=IDEMPOTENCY_KEY_DAYS)
            )
        )
        session.add(
            PlanIdempotencyKey(
                owner=owner,
                idempotency_key=payload.idempotency_key,
                input_sha256=_input_sha256(payload.user_input),
                plan_run_id=plan_run.id,
                response_json=response.model_dump_json(),
            )
        )

    try:
        session.commit()
    except IntegrityError:
        # A request with the same idempotency key finished first: its plan is the one kept.
        session.rollback()
        stored = _stored_answer(session, owner, payload)
        if stored is None:
            raise
        return stored
    return response
