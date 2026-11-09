from datetime import datetime, timedelta

from app.schemas import PlannerAction, PlannerOutput, PlannerTask


def build_demo_plan(user_input: str, now: datetime | None = None) -> PlannerOutput:
    """Deterministic planner used when no LLM API key is configured.

    This makes the backend demoable immediately.
    """
    now = now or datetime.now()
    tomorrow_10 = (now + timedelta(days=1)).replace(hour=10, minute=0, second=0, microsecond=0)
    tomorrow_14 = (now + timedelta(days=1)).replace(hour=14, minute=0, second=0, microsecond=0)
    day_after_9 = (now + timedelta(days=2)).replace(hour=9, minute=0, second=0, microsecond=0)

    lower = user_input.lower()

    tasks: list[PlannerTask] = []
    actions: list[PlannerAction] = []

    if "exam" in lower:
        tasks.append(
            PlannerTask(
                title="Prepare for upcoming exam",
                description="Review lecture notes, solve practice questions, and identify weak topics.",
                deadline=now + timedelta(days=7),
                estimated_minutes=360,
                priority=5,
            )
        )
        actions.append(
            PlannerAction(
                action_type="calendar_block",
                title="Deep study block for exam preparation",
                description="Focused session: review concepts and solve practice problems.",
                start_time=tomorrow_10,
                end_time=tomorrow_10 + timedelta(hours=2),
                risk_level="low",
                requires_approval=False,
            )
        )

    if "assignment" in lower or "assignments" in lower:
        tasks.append(
            PlannerTask(
                title="Finish assignment 1",
                description="Break down requirements, implement solution, and prepare submission.",
                deadline=now + timedelta(days=5),
                estimated_minutes=180,
                priority=4,
            )
        )
        tasks.append(
            PlannerTask(
                title="Finish assignment 2",
                description="Complete remaining tasks and check formatting before submission.",
                deadline=now + timedelta(days=6),
                estimated_minutes=180,
                priority=4,
            )
        )
        actions.append(
            PlannerAction(
                action_type="calendar_block",
                title="Assignment work block",
                description="Work on assignment deliverables without distractions.",
                start_time=tomorrow_14,
                end_time=tomorrow_14 + timedelta(hours=2),
                risk_level="low",
                requires_approval=False,
            )
        )

    if "meeting" in lower:
        tasks.append(
            PlannerTask(
                title="Decide whether to reschedule tomorrow's meeting",
                description="Check conflict with exam/assignment workload and send a rescheduling message if needed.",
                deadline=now + timedelta(days=1),
                estimated_minutes=15,
                priority=3,
            )
        )
        actions.append(
            PlannerAction(
                action_type="email_draft",
                title="Draft meeting reschedule email",
                description="Prepare a polite email asking to reschedule the meeting.",
                email_to="meeting.organizer@example.com",
                email_subject="Request to reschedule our meeting",
                email_body=(
                    "Hi,\n\nI hope you are doing well. I have an important academic deadline "
                    "and exam preparation this week, so I wanted to ask if we could reschedule "
                    "our meeting to another suitable time.\n\nThank you for your understanding.\n\nBest regards"
                ),
                risk_level="low",
                requires_approval=False,
            )
        )
        actions.append(
            PlannerAction(
                action_type="reminder",
                title="Review meeting conflict",
                description="Check whether the meeting should be rescheduled.",
                start_time=day_after_9,
                end_time=None,
                risk_level="low",
                requires_approval=False,
            )
        )

    if not tasks:
        tasks.append(
            PlannerTask(
                title="Clarify responsibilities",
                description="Break the input into concrete next actions.",
                deadline=None,
                estimated_minutes=30,
                priority=3,
            )
        )

    summary = (
        "I converted your chaotic input into prioritized tasks, calendar blocks, "
        "and safe action proposals."
    )

    execution_order = [
        "Confirm deadlines",
        "Block deep work time",
        "Prepare communication drafts",
        "Execute approved actions",
    ]

    return PlannerOutput(
        summary=summary,
        tasks=tasks,
        actions=actions,
        execution_order=execution_order,
    )
