from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select

from app.core.security import current_owner
from app.db.session import get_session
from app.models import Task, TaskStatus

router = APIRouter(prefix="/api/tasks", tags=["tasks"])


def _owned_task(session: Session, task_id: int, owner: str) -> Task:
    task = session.get(Task, task_id)
    if not task or task.owner != owner:
        raise HTTPException(status_code=404, detail="Task not found")
    return task


@router.get("")
def list_tasks(session: Session = Depends(get_session), owner: str = Depends(current_owner)):
    statement = (
        select(Task)
        .where(Task.owner == owner)
        .order_by(Task.status, Task.priority.desc(), Task.deadline)
    )
    return session.exec(statement).all()


@router.get("/{task_id}")
def get_task(task_id: int, session: Session = Depends(get_session), owner: str = Depends(current_owner)):
    return _owned_task(session, task_id, owner)


@router.post("/{task_id}/start")
def start_task(task_id: int, session: Session = Depends(get_session), owner: str = Depends(current_owner)):
    task = _owned_task(session, task_id, owner)

    task.status = TaskStatus.in_progress
    task.updated_at = datetime.utcnow()
    session.add(task)
    session.commit()
    session.refresh(task)
    return task


@router.post("/{task_id}/done")
def complete_task(task_id: int, session: Session = Depends(get_session), owner: str = Depends(current_owner)):
    task = _owned_task(session, task_id, owner)

    task.status = TaskStatus.done
    task.updated_at = datetime.utcnow()
    session.add(task)
    session.commit()
    session.refresh(task)
    return task
