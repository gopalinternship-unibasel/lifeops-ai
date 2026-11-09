from openai import OpenAI

from app.core.config import settings
from app.models import ActionProposal, ActionType


def _build_headers() -> dict | None:
    """
    Most Zapier MCP setups give you a server URL that already contains
    what is needed for access.

    If Zapier gives you a separate auth token, put it in:
    ZAPIER_MCP_AUTH_TOKEN
    """
    if not settings.zapier_mcp_auth_token:
        return None

    return {
        "Authorization": f"Bearer {settings.zapier_mcp_auth_token}"
    }


def execute_with_zapier_mcp(action: ActionProposal) -> dict:
    if not settings.openai_api_key:
        raise RuntimeError("OPENAI_API_KEY is missing.")

    if not settings.zapier_mcp_url:
        raise RuntimeError("ZAPIER_MCP_URL is missing.")

    client = OpenAI(api_key=settings.openai_api_key)

    if action.action_type == ActionType.calendar_block:
        if not action.start_time or not action.end_time:
            raise ValueError("Calendar action needs start_time and end_time.")

        instruction = f"""
You are executing one approved LifeOps AI action.

Use the Zapier Google Calendar tool to create exactly one calendar event.

Event title:
{action.title}

Description:
{action.description or ""}

Start time:
{action.start_time}

End time:
{action.end_time}

Timezone:
{settings.google_timezone}

Rules:
- Create only one calendar event.
- Do not create duplicates.
- Do not send emails.
- Return a short confirmation after the tool call.
"""

    elif action.action_type == ActionType.email_draft:
        if not action.email_to:
            raise ValueError(
                "Email draft action needs email_to before Zapier can create the draft."
            )

        instruction = f"""
You are executing one approved LifeOps AI action.

Use the Zapier Gmail tool to create exactly one Gmail draft.

Recipient:
{action.email_to}

Subject:
{action.email_subject or ""}

Body:
{action.email_body or ""}

Rules:
- Create a draft only.
- Do not send the email.
- Do not create duplicate drafts.
- Return a short confirmation after the tool call.
"""

    else:
        return {
            "status": "skipped",
            "provider": "zapier_mcp",
            "external_id": None,
            "result": f"Action type {action.action_type} is not handled by Zapier MCP.",
        }

    mcp_tool = {
        "type": "mcp",
        "server_label": "zapier",
        "server_description": "Zapier MCP server with Gmail and Google Calendar tools.",
        "server_url": settings.zapier_mcp_url,
        "require_approval": "never",
    }

    headers = _build_headers()
    if headers:
        mcp_tool["headers"] = headers

    response = client.responses.create(
        model=settings.openai_model,
        tools=[mcp_tool],
        input=instruction,
    )

    return {
        "status": "executed",
        "provider": "zapier_mcp",
        "external_id": None,
        "result": response.output_text,
    }