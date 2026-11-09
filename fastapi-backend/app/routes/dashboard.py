from fastapi import APIRouter, Depends
from sqlmodel import Session, select

from app.core.security import current_owner
from app.db.session import get_session
from app.models import ActionProposal, ActionStatus, PlanRun, Task, TaskStatus

router = APIRouter(prefix="/api", tags=["dashboard"])


@router.get("/dashboard")
def dashboard(session: Session = Depends(get_session), owner: str = Depends(current_owner)):
    tasks = session.exec(select(Task).where(Task.owner == owner)).all()
    actions = session.exec(select(ActionProposal).where(ActionProposal.owner == owner)).all()
    last_run = session.exec(
        select(PlanRun).where(PlanRun.owner == owner).order_by(PlanRun.created_at.desc())
    ).first()

    pending_tasks = [t for t in tasks if t.status != TaskStatus.done]
    done_tasks = [t for t in tasks if t.status == TaskStatus.done]

    pending_actions = [a for a in actions if a.status == ActionStatus.pending]
    approved_actions = [a for a in actions if a.status == ActionStatus.approved]
    executed_actions = [a for a in actions if a.status == ActionStatus.executed]

    # Highest priority first; among equals, the earliest deadline first, undated last.
    next_tasks = sorted(
        pending_tasks,
        key=lambda t: (-t.priority, t.deadline is None, t.deadline or t.created_at),
    )[:5]

    return {
        "before": {
            "label": "Chaos",
            "description": "Responsibilities were unstructured and not execution-ready.",
        },
        "after": {
            "label": "Operational plan",
            "description": "Tasks, calendar blocks, drafts, and execution order are now structured.",
        },
        "metrics": {
            "total_tasks": len(tasks),
            "pending_tasks": len(pending_tasks),
            "done_tasks": len(done_tasks),
            "total_actions": len(actions),
            "pending_actions": len(pending_actions),
            "approved_actions": len(approved_actions),
            "executed_actions": len(executed_actions),
        },
        "last_plan": last_run,
        "next_best_actions": next_tasks,
        "tasks": tasks,
        "actions": actions,
    }
