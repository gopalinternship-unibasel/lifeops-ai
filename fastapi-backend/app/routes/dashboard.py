from fastapi import APIRouter, Depends
from sqlmodel import Session, select

from app.db.session import get_session
from app.models import ActionProposal, ActionStatus, Task, TaskStatus

router = APIRouter(prefix="/api", tags=["dashboard"])


@router.get("/dashboard")
def dashboard(session: Session = Depends(get_session)):
    tasks = session.exec(select(Task)).all()
    actions = session.exec(select(ActionProposal)).all()

    pending_tasks = [t for t in tasks if t.status != TaskStatus.done]
    done_tasks = [t for t in tasks if t.status == TaskStatus.done]

    pending_actions = [a for a in actions if a.status == ActionStatus.pending]
    approved_actions = [a for a in actions if a.status == ActionStatus.approved]
    executed_actions = [a for a in actions if a.status == ActionStatus.executed]

    next_tasks = sorted(
        pending_tasks,
        key=lambda t: (-t.priority, t.deadline is None, t.deadline),
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
        "next_best_actions": next_tasks,
        "tasks": tasks,
        "actions": actions,
    }
