import hmac
import re

from fastapi import Header, HTTPException

from app.core.config import settings

_OWNER_RE = re.compile(r"[^A-Za-z0-9_.:@-]")


def accepted_backend_tokens() -> list[str]:
    """LIFEOPS_BACKEND_TOKEN plus any LIFEOPS_BACKEND_EXTRA_TOKENS (comma separated)."""
    tokens: list[str] = []
    if settings.lifeops_backend_token and settings.lifeops_backend_token.strip():
        tokens.append(settings.lifeops_backend_token.strip())
    if settings.lifeops_backend_extra_tokens:
        tokens.extend(t.strip() for t in settings.lifeops_backend_extra_tokens.split(",") if t.strip())
    return tokens


def require_backend_token(
    authorization: str | None = Header(default=None),
    x_lifeops_token: str | None = Header(default=None),
) -> None:
    """Reject /api calls without an accepted shared secret once any token is configured."""
    accepted = accepted_backend_tokens()
    if not accepted:
        # No token configured: the service is open (local use).
        return
    supplied = x_lifeops_token
    if not supplied and authorization and authorization.lower().startswith("bearer "):
        supplied = authorization[7:].strip()
    if not supplied:
        raise HTTPException(status_code=401, detail="Missing or invalid LifeOps backend token")
    # Compare against every accepted token (no early exit), so timing does not tell which matched.
    matched = False
    for expected in accepted:
        matched = hmac.compare_digest(supplied.encode(), expected.encode()) or matched
    if not matched:
        raise HTTPException(status_code=401, detail="Missing or invalid LifeOps backend token")


def current_owner(x_lifeops_user: str | None = Header(default=None)) -> str:
    """Whose data a request touches. The MONDAY app sends its signed-in user's id.

    Direct callers (curl, /docs) that send no header share the "local" workspace.
    """
    if not x_lifeops_user:
        return "local"
    owner = _OWNER_RE.sub("", x_lifeops_user.strip())[:64]
    return owner or "local"
