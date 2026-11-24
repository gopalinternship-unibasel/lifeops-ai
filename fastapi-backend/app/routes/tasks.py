from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import case
from sqlmodel import Session, select

from app.core.security import current_owner
from app.db.session import get_session
from app.models import Task, TaskStatus

router = APIRouter(prefix="/api/tasks", tags=["tasks"])


def task_order():
    """Open tasks first (pending, then in progress, then done), the most important first, then the
    earliest deadline, undated last.

    Spelled out instead of ORDER BY status: the database decides how a status column sorts (a
    PostgreSQL enum by declaration, SQLite text alphabetically, which put done tasks first), and
    where NULL deadlines go (last on PostgreSQL, first on SQLite).
    """
    status_rank = case(
        {TaskStatus.pending: 0, TaskStatus.in_progress: 1, TaskStatus.done: 2},
        value=Task.status,
        else_=3,
    )
    return (status_rank, Task.priority.desc(), Task.deadline.is_(None), Task.deadline, Task.id)


def _owned_task(session: Session, task_id: int, owner: str) -> Task:
    task = session.get(Task, task_id)
    if not task or task.owner != owner:
        raise HTTPException(status_code=404, detail="Task not found")
    return task


@router.get("")
def list_tasks(session: Session = Depends(get_session), owner: str = Depends(current_owner)):
    statement = select(Task).where(Task.owner == owner).order_by(*task_order())
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
    return task


@router.post("/{task_id}/done")
def complete_task(task_id: int, session: Session = Depends(get_session), owner: str = Depends(current_owner)):
    task = _owned_task(session, task_id, owner)

    task.status = TaskStatus.done
    task.updated_at = datetime.utcnow()
    session.add(task)
    session.commit()
    return task
