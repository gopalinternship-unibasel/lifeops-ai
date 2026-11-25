from fastapi import APIRouter, Depends, Query
from sqlalchemy import func
from sqlmodel import Session, select

from app.core.security import current_owner
from app.db.session import get_session
from app.models import ActionProposal, ActionStatus, PlanRun, Task, TaskStatus
from app.routes.actions import action_order
from app.routes.tasks import task_order

router = APIRouter(prefix="/api", tags=["dashboard"])

# The task and action lists are bounded: an owner's history only grows (rows are kept until the
# hosted clean-up deletes the owner), and the whole of it was sent on every dashboard read. Open
# items come first in both lists, so they are the last to be cut. The metrics count everything.
DEFAULT_LIST_LIMIT = 200
MAX_LIST_LIMIT = 500


def _counts(session: Session, column, owner_column, owner: str) -> dict:
    rows = session.exec(select(column, func.count()).where(owner_column == owner).group_by(column)).all()
    return {status: count for status, count in rows}


@router.get("/dashboard")
def dashboard(
    limit: int = Query(default=DEFAULT_LIST_LIMIT, description="Most tasks and most actions to list (1-500)."),
    session: Session = Depends(get_session),
    owner: str = Depends(current_owner),
):
    # Out-of-range values are clamped rather than refused, so a client asking for more still works.
    limit = max(1, min(limit, MAX_LIST_LIMIT))

    task_counts = _counts(session, Task.status, Task.owner, owner)
    action_counts = _counts(session, ActionProposal.status, ActionProposal.owner, owner)
    tasks = session.exec(select(Task).where(Task.owner == owner).order_by(*task_order()).limit(limit)).all()
    actions = session.exec(
        select(ActionProposal).where(ActionProposal.owner == owner).order_by(*action_order()).limit(limit)
    ).all()
    last_run = session.exec(
        select(PlanRun).where(PlanRun.owner == owner).order_by(PlanRun.created_at.desc(), PlanRun.id.desc())
    ).first()

    # Highest priority first; among equals, the earliest deadline first, undated last (by age).
    next_tasks = session.exec(
        select(Task)
        .where(Task.owner == owner, Task.status != TaskStatus.done)
        .order_by(Task.priority.desc(), Task.deadline.is_(None), Task.deadline, Task.created_at, Task.id)
        .limit(5)
    ).all()

    total_tasks = sum(task_counts.values())
    done_tasks = task_counts.get(TaskStatus.done, 0)

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
            "total_tasks": total_tasks,
            "pending_tasks": total_tasks - done_tasks,
            "done_tasks": done_tasks,
            "total_actions": sum(action_counts.values()),
            "pending_actions": action_counts.get(ActionStatus.pending, 0),
            "approved_actions": action_counts.get(ActionStatus.approved, 0),
            "executed_actions": action_counts.get(ActionStatus.executed, 0),
        },
        "last_plan": last_run,
        "next_best_actions": next_tasks,
        "tasks": tasks,
        "actions": actions,
    }
