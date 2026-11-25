from datetime import datetime

from fastapi import APIRouter, Depends
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, select

from app.core.config import settings
from app.core.security import current_owner
from app.db.session import get_session
from app.models import AppSettings
from app.schemas import AutonomousModeRequest

router = APIRouter(prefix="/api/settings", tags=["settings"])


def _find_settings(session: Session, owner: str) -> AppSettings | None:
    return session.exec(select(AppSettings).where(AppSettings.owner == owner)).first()


def get_or_create_settings(session: Session, owner: str = "local") -> AppSettings:
    """The owner's settings row, created on first use.

    Two first requests of a new owner can both miss the row and both insert it; the owner column
    is unique, so the slower insert fails. That request then reads the row the other one made
    instead of failing. Call this before the request writes anything else: the losing insert is
    undone with a rollback of the whole session.
    """
    row = _find_settings(session, owner)
    if row:
        return row

    row = AppSettings(owner=owner, autonomous_mode=settings.autonomous_mode_default)
    session.add(row)
    try:
        session.commit()
    except IntegrityError:
        session.rollback()
        existing = _find_settings(session, owner)
        if existing is None:
            raise
        return existing
    return row


@router.get("")
def read_settings(session: Session = Depends(get_session), owner: str = Depends(current_owner)):
    row = get_or_create_settings(session, owner)
    return row


@router.post("/autonomous-mode")
def set_autonomous_mode(
    payload: AutonomousModeRequest,
    session: Session = Depends(get_session),
    owner: str = Depends(current_owner),
):
    row = get_or_create_settings(session, owner)
    row.autonomous_mode = payload.enabled
    row.updated_at = datetime.utcnow()

    session.add(row)
    session.commit()

    return row
