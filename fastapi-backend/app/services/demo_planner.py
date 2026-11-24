"""The keyword planner: used when no AI model is set up, or when the model's answer is unusable.

It recognises three things (exams, assignments, meetings) as whole words and a few plain dates
("today", "tomorrow", "Friday", "2026-11-28", "28 Nov"), and it says so in its summary. It never
invents dates: a deadline it cannot read stays empty, and the description asks the user to
confirm it. The times of its blocks and reminders are guesses, so every proposal needs the user's
approval (requires_approval), and neither autonomous mode nor execute-safe runs them on their own.
"""

import re
from datetime import date, datetime, time, timedelta

from app.schemas import PlannerAction, PlannerOutput, PlannerTask

_EXAM = re.compile(r"\bexam(?:s|ination|inations)?\b")
_ASSIGNMENT = re.compile(r"\bassignments?\b")
_MEETING = re.compile(r"\bmeetings?\b")
# A date belongs to the keyword in the same part of the sentence ("exams next week, a meeting
# tomorrow"): the text is split at punctuation and at joining words.
_CLAUSE_BREAK = re.compile(r"[,;.!?\n]+|\b(?:and|but|then|also|plus)\b")

_WEEKDAYS = ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")
_MONTH = (
    r"jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?"
    r"|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?"
)
_DATE = re.compile(
    r"\b(?:"
    r"(?P<day_after>day after tomorrow)"
    r"|(?P<tomorrow>tomorrow)"
    r"|(?P<today>today|tonight)"
    r"|(?P<next>next\s+)?(?P<weekday>" + "|".join(_WEEKDAYS) + r")"
    r"|(?P<iso>\d{4}-\d{2}-\d{2})"
    r"|(?P<dm_day>\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(?P<dm_month>" + _MONTH + r")(?:\s+(?P<dm_year>\d{4}))?"
    r"|(?P<md_month>" + _MONTH + r")\.?\s+(?P<md_day>\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(?P<md_year>\d{4}))?"
    r")\b"
)

_DRAFT_BODY = (
    "Hi,\n\nI hope you are well. I have a scheduling conflict, so I wanted to ask whether we could "
    "move our meeting to another time that suits you.\n\nThank you for your understanding.\n\nBest regards"
)


def _month_number(name: str) -> int:
    return ("jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec").index(name[:3]) + 1


def _calendar_date(year: str | None, month: str, day: str, today: date) -> date | None:
    try:
        found = date(int(year) if year else today.year, _month_number(month), int(day))
    except ValueError:
        return None
    if not year and found < today:
        # "3 Jan" written in November means next January.
        try:
            found = found.replace(year=found.year + 1)
        except ValueError:
            return None
    return found


def read_date(text: str, today: date) -> date | None:
    """The first date the text names exactly, or None ("next week" is not an exact date).

    A weekday is its next occurrence, today included; "next Friday" is the same as "Friday",
    except on a Friday, where it is a week later.
    """
    for match in _DATE.finditer(text.lower()):
        if match.group("day_after"):
            return today + timedelta(days=2)
        if match.group("tomorrow"):
            return today + timedelta(days=1)
        if match.group("today"):
            return today
        if match.group("weekday"):
            ahead = (_WEEKDAYS.index(match.group("weekday")) - today.weekday()) % 7
            if match.group("next") and ahead == 0:
                ahead = 7
            return today + timedelta(days=ahead)
        if match.group("iso"):
            try:
                return date.fromisoformat(match.group("iso"))
            except ValueError:
                continue
        if match.group("dm_month"):
            found = _calendar_date(match.group("dm_year"), match.group("dm_month"), match.group("dm_day"), today)
        else:
            found = _calendar_date(match.group("md_year"), match.group("md_month"), match.group("md_day"), today)
        if found:
            return found
    return None


def _clause_with(pattern: re.Pattern, text: str) -> tuple[str, str] | None:
    """(matched word, its clause) for the first clause that contains the keyword."""
    for clause in _CLAUSE_BREAK.split(text):
        match = pattern.search(clause)
        if match:
            return match.group(0), clause
    return None


def _day_label(day: date) -> str:
    return f"{day:%A} {day.day} {day:%B}"


def _no_date_hint(clause: str, what: str) -> str:
    if "next week" in clause:
        return f"Confirm the date of {what}: your text says next week."
    return f"Confirm the date of {what}: no date was found in your text."


def _plural(count: int, word: str) -> str:
    return f"{count} {word}" if count == 1 else f"{count} {word}s"


def build_demo_plan(user_input: str, now: datetime | None = None) -> PlannerOutput:
    """Deterministic plan from keywords. `now` is the user's naive local wall-clock time."""
    now = now or datetime.now()
    today = now.date()
    tomorrow = today + timedelta(days=1)
    lower = user_input.lower()

    tasks: list[PlannerTask] = []
    actions: list[PlannerAction] = []

    exam = _clause_with(_EXAM, lower)
    if exam:
        word, clause = exam
        the = "the exams" if word.endswith("s") else "the exam"
        exam_day = read_date(clause, today)
        description = "Review the lecture notes, solve practice questions and find the weak topics."
        if exam_day:
            description += f" {the.capitalize()}: {_day_label(exam_day)}."
        else:
            description += " " + _no_date_hint(clause, the)
        tasks.append(
            PlannerTask(
                title=f"Prepare for {the}",
                description=description,
                # Ready by the morning of the exam day.
                deadline=datetime.combine(exam_day, time(8, 0)) if exam_day else None,
                estimated_minutes=360,
                priority=5,
            )
        )
        if exam_day is None or exam_day > tomorrow:
            start = datetime.combine(tomorrow, time(10, 0))
            actions.append(
                PlannerAction(
                    action_type="calendar_block",
                    title=f"Study block for {the}",
                    description="A suggested time for focused study. Reject it if the time does not suit you.",
                    start_time=start,
                    end_time=start + timedelta(hours=2),
                    risk_level="low",
                    requires_approval=True,
                )
            )

    assignment = _clause_with(_ASSIGNMENT, lower)
    if assignment:
        word, clause = assignment
        the = "the assignments" if word.endswith("s") else "the assignment"
        due = read_date(clause, today)
        description = "Break down the requirements, do the work and check it before you hand it in."
        description += f" Due {_day_label(due)}." if due else " " + _no_date_hint(clause, the)
        tasks.append(
            PlannerTask(
                title=f"Finish {the}",
                description=description,
                deadline=datetime.combine(due, time(23, 59)) if due else None,
                estimated_minutes=180,
                priority=4,
            )
        )
        if due is None or due > today:
            start = datetime.combine(tomorrow, time(14, 0))
            actions.append(
                PlannerAction(
                    action_type="calendar_block",
                    title=f"Work block for {the}",
                    description="A suggested time to work on it without distractions. Reject it if the time does not suit you.",
                    start_time=start,
                    end_time=start + timedelta(hours=2),
                    risk_level="low",
                    requires_approval=True,
                )
            )

    meeting = _clause_with(_MEETING, lower)
    if meeting:
        _, clause = meeting
        day = read_date(clause, today)
        if day == today:
            label = "today's meeting"
        elif day == tomorrow:
            label = "tomorrow's meeting"
        elif day:
            label = f"the meeting on {_day_label(day)}"
        else:
            label = "the meeting"
        decide_by = datetime.combine(day, time(8, 0)) if day else None
        tasks.append(
            PlannerTask(
                title=f"Decide whether to reschedule {label}",
                description="Check whether the meeting clashes with your other plans and ask to move it if needed."
                + ("" if day else " Confirm when the meeting is."),
                deadline=decide_by if decide_by and decide_by > now else None,
                estimated_minutes=15,
                priority=3,
            )
        )
        actions.append(
            PlannerAction(
                action_type="email_draft",
                title="Draft an email asking to reschedule the meeting",
                description="A polite request to move the meeting. Type the recipient in the To field before you run it.",
                # No address book here: the recipient is added before the draft is made.
                email_to=None,
                email_subject="Request to reschedule our meeting",
                email_body=_DRAFT_BODY,
                risk_level="low",
                requires_approval=True,
            )
        )
        # Remind before the meeting: the morning before it, else early on its day, else not at all.
        if day:
            options = [datetime.combine(day - timedelta(days=1), time(9, 0)), datetime.combine(day, time(8, 0))]
        else:
            options = [datetime.combine(tomorrow, time(9, 0))]
        remind_at = next((option for option in options if option > now), None)
        if remind_at:
            actions.append(
                PlannerAction(
                    action_type="reminder",
                    title=f"Decide about {label}",
                    description="Check whether the meeting should be rescheduled.",
                    start_time=remind_at,
                    end_time=None,
                    risk_level="low",
                    requires_approval=True,
                )
            )

    if tasks:
        summary = (
            f"The keyword planner made {_plural(len(tasks), 'task')} and "
            f"{_plural(len(actions), 'proposed action')} from your text. It only recognises exams, "
            "assignments, meetings and simple dates, so check every date and time before you approve anything."
        )
    else:
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
            "The keyword planner found no exam, assignment or meeting in your text, "
            "so it added one task to sort out what to do first."
        )

    kinds = {action.action_type for action in actions}
    execution_order = ["Check the tasks and confirm their dates"]
    if "calendar_block" in kinds:
        execution_order.append("Approve or reject the suggested time blocks")
    if "email_draft" in kinds:
        execution_order.append("Type the draft's recipient in its To field and check its text")
    if "reminder" in kinds:
        execution_order.append("Approve or reject the reminder")
    if actions:
        execution_order.append("Run the actions you approved")

    return PlannerOutput(
        summary=summary,
        tasks=tasks,
        actions=actions,
        execution_order=execution_order,
    )
