from datetime import datetime

from fastapi import APIRouter, Depends
from sqlmodel import Session, select

from app.core.config import settings
from app.core.security import current_owner
from app.db.session import get_session
from app.models import AppSettings
from app.schemas import AutonomousModeRequest

router = APIRouter(prefix="/api/settings", tags=["settings"])


def get_or_create_settings(session: Session, owner: str = "local") -> AppSettings:
    row = session.exec(select(AppSettings).where(AppSettings.owner == owner)).first()
    if row:
        return row

    row = AppSettings(owner=owner, autonomous_mode=settings.autonomous_mode_default)
    session.add(row)
    session.commit()
    session.refresh(row)
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
    session.refresh(row)

    return row
