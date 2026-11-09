from uuid import uuid4

from app.core.config import settings


def create_gmail_draft(
    to: str | None,
    subject: str | None,
    body: str | None,
) -> dict:
    """Gmail draft adapter.

    MVP mode returns a mock result.

    Replace this file with real Gmail OAuth logic later:
    - load user's OAuth credentials
    - create RFC 2822 MIME email
    - base64url encode it
    - call service.users().drafts().create(userId="me", body={"message": {"raw": raw}}).execute()
    """
    if settings.google_integration_mode == "mock":
        return {
            "mode": "mock",
            "external_id": f"mock-gmail-draft-{uuid4()}",
            "to": to,
            "subject": subject,
            "body": body,
        }

    raise NotImplementedError("Real Gmail integration is not wired yet.")
