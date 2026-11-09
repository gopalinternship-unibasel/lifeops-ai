from fastapi import APIRouter, Depends
from sqlmodel import Session

from app.core.security import current_owner
from app.db.session import get_session
from app.models import ActionProposal, PlanRun, Task
from app.routes.settings import get_or_create_settings
from app.schemas import PlanRequest, PlanResponse
from app.services.action_executor import apply_execution_result, execute_action
from app.services.llm_planner import create_plan
from app.services.safety import can_auto_execute, requires_human_approval

router = APIRouter(prefix="/api", tags=["plan"])


@router.post("/plan", response_model=PlanResponse)
def create_lifeops_plan(
    payload: PlanRequest,
    session: Session = Depends(get_session),
    owner: str = Depends(current_owner),
):
    plan, planner, planner_note = create_plan(
        payload.user_input,
        now=payload.current_datetime,
        timezone=payload.timezone,
    )

    app_settings = get_or_create_settings(session, owner)
    effective_autonomous_mode = payload.autonomous_mode or app_settings.autonomous_mode

    plan_run = PlanRun(
        owner=owner,
        user_input=payload.user_input,
        summary=plan.summary,
        autonomous_mode_used=effective_autonomous_mode,
        planner=planner,
    )
    session.add(plan_run)
    session.commit()
    session.refresh(plan_run)

    task_count = 0
    action_count = 0
    executed_safe_actions = 0

    for item in plan.tasks:
        task = Task(
            owner=owner,
            title=item.title,
            description=item.description,
            deadline=item.deadline,
            estimated_minutes=item.estimated_minutes,
            priority=item.priority,
            source=f"plan_run:{plan_run.id}",
        )
        session.add(task)
        task_count += 1

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
        session.commit()
        session.refresh(action)

        action_count += 1

        if effective_autonomous_mode and can_auto_execute(action):
            result = execute_action(action)
            action = apply_execution_result(action, result)
            session.add(action)
            executed_safe_actions += 1

    session.commit()

    return PlanResponse(
        plan_run_id=plan_run.id,
        summary=plan.summary,
        tasks_created=task_count,
        actions_created=action_count,
        executed_safe_actions=executed_safe_actions,
        plan=plan,
        planner=planner,
        planner_note=planner_note,
    )
