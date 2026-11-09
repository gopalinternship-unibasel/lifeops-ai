import json
from datetime import datetime

from openai import OpenAI
from pydantic import ValidationError

from app.core.config import settings
from app.schemas import PlannerOutput
from app.services.demo_planner import build_demo_plan


SYSTEM_PROMPT = """
You are LifeOps AI, an agentic operations planner for personal productivity.

Your job:
Convert chaotic user input into an executable plan.

Return strict JSON only.

Schema:
{
  "summary": "short summary",
  "tasks": [
    {
      "title": "string",
      "description": "string or null",
      "deadline": "ISO datetime string or null",
      "estimated_minutes": 60,
      "priority": 1
    }
  ],
  "actions": [
    {
      "action_type": "task | calendar_block | email_draft | reminder",
      "title": "string",
      "description": "string or null",
      "start_time": "ISO datetime string or null",
      "end_time": "ISO datetime string or null",
      "email_to": "email address or null",
      "email_subject": "string or null",
      "email_body": "string or null",
      "risk_level": "low | medium | high",
      "requires_approval": true
    }
  ],
  "execution_order": ["step 1", "step 2"]
}

Rules:
- Use the current datetime given by the backend.
- If the date is vague, make a reasonable schedule and explain it in the description.
- Do not send emails.
- Email actions must only be drafts.
- High-risk actions require approval.
- Low-risk calendar blocks, reminders, tasks, and drafts can be marked requires_approval=false.
- Priorities: 5 = most important, 1 = least important.
"""


def create_plan(user_input: str) -> PlannerOutput:
    if not settings.openai_api_key:
        return build_demo_plan(user_input)

    client = OpenAI(api_key=settings.openai_api_key)

    try:
        response = client.chat.completions.create(
            model=settings.openai_model,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {
                    "role": "user",
                    "content": (
                        f"Current datetime: {datetime.now().isoformat()}\n\n"
                        f"User input:\n{user_input}"
                    ),
                },
            ],
            response_format={"type": "json_object"},
            temperature=0.2,
        )

        raw = response.choices[0].message.content or "{}"
        data = json.loads(raw)
        return PlannerOutput.model_validate(data)

    except (json.JSONDecodeError, ValidationError, Exception):
        # Fallback keeps demo alive.
        return build_demo_plan(user_input)
