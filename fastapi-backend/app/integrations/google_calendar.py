from datetime import datetime
from uuid import uuid4

from app.core.config import settings


def create_calendar_event(
    title: str,
    description: str | None,
    start_time: datetime | None,
    end_time: datetime | None,
) -> dict:
    """Calendar execution adapter.

    MVP mode returns a mock result.

    Replace this file with real Google Calendar OAuth logic later:
    - load user's OAuth credentials
    - build Google Calendar service
    - call service.events().insert(calendarId="primary", body=event).execute()
    """
    if settings.google_integration_mode == "mock":
        return {
            "mode": "mock",
            "external_id": f"mock-calendar-{uuid4()}",
            "title": title,
            "description": description,
            "start_time": start_time.isoformat() if start_time else None,
            "end_time": end_time.isoformat() if end_time else None,
            "timezone": settings.google_timezone,
        }

    raise NotImplementedError("Real Google Calendar integration is not wired yet.")
