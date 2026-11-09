import hmac
import re

from fastapi import Header, HTTPException

from app.core.config import settings

_OWNER_RE = re.compile(r"[^A-Za-z0-9_.:@-]")


def require_backend_token(
    authorization: str | None = Header(default=None),
    x_lifeops_token: str | None = Header(default=None),
) -> None:
    """Reject /api calls without the shared secret when LIFEOPS_BACKEND_TOKEN is set."""
    expected = settings.lifeops_backend_token
    if not expected:
        return
    supplied = x_lifeops_token
    if not supplied and authorization and authorization.lower().startswith("bearer "):
        supplied = authorization[7:].strip()
    if not supplied or not hmac.compare_digest(supplied.encode(), expected.encode()):
        raise HTTPException(status_code=401, detail="Missing or invalid LifeOps backend token")


def current_owner(x_lifeops_user: str | None = Header(default=None)) -> str:
    """Whose data a request touches. The MONDAY app sends its signed-in user's id.

    Direct callers (curl, /docs) that send no header share the "local" workspace.
    """
    if not x_lifeops_user:
        return "local"
    owner = _OWNER_RE.sub("", x_lifeops_user.strip())[:64]
    return owner or "local"
