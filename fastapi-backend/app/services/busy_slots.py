"""Keep a plan clear of the caller's calendar, and drop plans the caller stopped waiting for.

The MONDAY dashboard sends the user's busy times with each plan request. Neither planner (the
model or the keyword planner) is guaranteed to respect them: the keyword planner uses fixed
slots (tomorrow 10:00 was the seeded demo lecture), and a model can ignore the list. So after
planning, every calendar block and reminder that overlaps a busy time, or another block of the
same plan, is moved to the next free slot of the same length between 08:00 and 20:00, and the
planner note says so. Without this the proposals could only fail when the user ran them.

All times are naive local wall-clock times in the user's zone, as in the rest of the planner.
"""

import re
from datetime import datetime, timedelta, timezone

from app.schemas import BusyInterval, PlannerOutput, PlannerTask

DAY_START_HOUR = 8
DAY_END_HOUR = 20
STEP = timedelta(minutes=15)
SEARCH_DAYS = 7
# The MONDAY app writes a reminder as a 15-minute calendar entry ("Reminder: <what>").
REMINDER_LENGTH = timedelta(minutes=15)


def deadline_passed(deadline: datetime | None, now: datetime | None = None) -> bool:
    """True once the caller's deadline (UTC; a naive value is read as UTC) has passed."""
    if deadline is None:
        return False
    if deadline.tzinfo is None:
        deadline = deadline.replace(tzinfo=timezone.utc)
    return (now or datetime.now(timezone.utc)) >= deadline


def _naive(value: datetime) -> datetime:
    return value.replace(tzinfo=None) if value.tzinfo else value


def _overlaps(start: datetime, end: datetime, taken: list[tuple[datetime, datetime]]) -> bool:
    return any(start < taken_end and taken_start < end for taken_start, taken_end in taken)


def _round_up(value: datetime) -> datetime:
    value = value.replace(second=0, microsecond=0)
    extra = value.minute % 15
    return value + timedelta(minutes=15 - extra) if extra else value


def next_free_slot(
    length: timedelta,
    earliest: datetime,
    taken: list[tuple[datetime, datetime]],
    deadline: datetime | None = None,
) -> tuple[datetime, datetime] | None:
    """The first slot of `length` from `earliest` on, between 08:00 and 20:00, that overlaps nothing
    in `taken`; None when the next SEARCH_DAYS days have none. With a `deadline` the slot must also
    end by it."""
    candidate = _round_up(earliest)
    limit = earliest + timedelta(days=SEARCH_DAYS)
    while candidate < limit:
        day_start = candidate.replace(hour=DAY_START_HOUR, minute=0)
        day_end = candidate.replace(hour=DAY_END_HOUR, minute=0)
        if candidate < day_start:
            candidate = day_start
            continue
        if candidate + length > day_end:
            candidate = (candidate + timedelta(days=1)).replace(hour=DAY_START_HOUR, minute=0)
            continue
        end = candidate + length
        if deadline is not None and end > deadline:
            return None
        if not _overlaps(candidate, end, taken):
            return candidate, end
        candidate += STEP
    return None


def latest_free_slot_before(
    length: timedelta,
    earliest: datetime,
    latest_start: datetime,
    taken: list[tuple[datetime, datetime]],
    deadline: datetime | None = None,
) -> tuple[datetime, datetime] | None:
    """The free slot of `length` that starts closest before `latest_start` (and not before
    `earliest`), between 08:00 and 20:00 and ending by `deadline`; None when there is none."""
    best = None
    candidate = _round_up(earliest)
    while candidate < latest_start:
        end = candidate + length
        in_day = candidate.hour >= DAY_START_HOUR and end <= candidate.replace(hour=DAY_END_HOUR, minute=0)
        if in_day and (deadline is None or end <= deadline) and not _overlaps(candidate, end, taken):
            best = (candidate, end)
        candidate += STEP
    return best


_FILLER_WORDS = {
    "the", "and", "for", "with", "work", "block", "time", "session", "complete", "finish", "prepare",
    "your", "task", "tasks", "this", "that", "from", "into", "draft", "email", "reminder", "call",
}


def _stems(text: str) -> set[str]:
    """Words of a title as their first five letters, so "assignment" and "assignments" match."""
    words = re.findall(r"[a-z0-9]+", text.lower())
    return {word[:5] for word in words if len(word) >= 3 and word not in _FILLER_WORDS}


# Words that many unrelated titles share ("Lunch with team", "Team sync prep"): one of them alone
# does not tie a block to a task.
_COMMON_STEMS = {
    "team", "meeti", "call", "sync", "prep", "work", "lunch", "break", "check", "plan", "revie",
    "dinne", "coffe", "catch", "stand", "daily", "weekl", "gym", "walk", "sessi", "study",
}


def related_deadline(title: str, tasks: list[PlannerTask]) -> datetime | None:
    """The deadline of the task a block or reminder is about: the task whose title shares the most
    words with the block's title (the earliest deadline on a tie). A task is linked only when it
    shares at least two words, or one word that is not a common one (team, meeting, call, ...).
    None when no task with a deadline qualifies, and then nothing limits the block's new time."""
    words = _stems(title)
    best: tuple[int, datetime] | None = None
    for task in tasks:
        if task.deadline is None:
            continue
        common = words & _stems(task.title)
        if len(common) < 2 and not (common - _COMMON_STEMS):
            continue
        shared = len(common)
        deadline = _naive(task.deadline)
        if best is None or shared > best[0] or (shared == best[0] and deadline < best[1]):
            best = (shared, deadline)
    return best[1] if best else None


def keep_clear_of_busy(
    plan: PlannerOutput,
    busy: list[BusyInterval],
    now: datetime | None = None,
) -> tuple[PlannerOutput, str | None]:
    """Move calendar blocks and reminders off the busy times (see the module docstring).

    Returns the plan (changed in place) and a note for the user, or None when nothing moved. A
    request without busy times is left exactly as planned.
    """
    taken = [(_naive(item.start), _naive(item.end)) for item in busy if _naive(item.end) > _naive(item.start)]
    if not taken:
        return plan, None
    earliest_allowed = _naive(now) if now else None

    timed = []
    for action in plan.actions:
        if action.action_type == "calendar_block" and action.start_time and action.end_time:
            timed.append((action, _naive(action.start_time), _naive(action.end_time)))
        elif action.action_type == "reminder" and action.start_time:
            start = _naive(action.start_time)
            timed.append((action, start, start + REMINDER_LENGTH))
    timed.sort(key=lambda item: item[1])

    # First keep everything that fits where it is, then move the rest around all of it, so a
    # moved block never pushes out one that was fine.
    to_move = []
    for action, start, end in timed:
        if _overlaps(start, end, taken):
            to_move.append((action, start, end))
        else:
            taken.append((start, end))

    moved: list[str] = []
    stuck: list[str] = []
    # Blocks of a task with a deadline stay before it: moves are searched between the start of the
    # block's own day (or now, if later) and the deadline, earlier slots included.
    too_late: list[str] = []
    deadline_over: list[str] = []
    for action, start, end in to_move:
        earliest = max(start, earliest_allowed) if earliest_allowed else start
        deadline = related_deadline(action.title, plan.tasks)
        if deadline is not None and earliest_allowed and deadline <= earliest_allowed:
            # The deadline is already over: nothing to keep it before, so the block moves forward
            # as it would without a task, and the note says so.
            deadline_over.append(f"'{action.title}'")
            deadline = None
        slot = next_free_slot(end - start, earliest, taken, deadline)
        if slot is None and deadline is not None:
            if start > deadline:
                # The block is after the deadline: look from now (or from the deadline's day).
                window_start = earliest_allowed or deadline.replace(hour=0, minute=0, second=0, microsecond=0)
            else:
                window_start = start.replace(hour=0, minute=0, second=0, microsecond=0)
                if earliest_allowed:
                    window_start = max(window_start, earliest_allowed)
            slot = latest_free_slot_before(end - start, window_start, start, taken, deadline)
            if slot is None:
                too_late.append(f"'{action.title}'")
                taken.append((start, end))
                continue
        if slot is None:
            stuck.append(f"'{action.title}'")
            taken.append((start, end))
            continue
        new_start, new_end = slot
        if action.action_type == "calendar_block":
            action.end_time = new_end
        elif action.end_time is not None:
            # A reminder keeps its own length, if it has one.
            action.end_time = _naive(action.end_time) + (new_start - start)
        action.start_time = new_start
        taken.append(slot)
        moved.append(f"'{action.title}' to {new_start:%a %d %b %H:%M}")

    notes = []
    if moved:
        notes.append(f"Moved {', '.join(moved)}, because the planned time overlapped your calendar.")
    if stuck:
        notes.append(f"Found no free time in the next week for {', '.join(stuck)}; it overlaps your calendar.")
    if too_late:
        notes.append(
            f"Found no free time before the deadline for {', '.join(too_late)}; it stays where it was and overlaps your calendar."
        )
    if deadline_over:
        notes.append(f"The deadline for {', '.join(deadline_over)} has already passed.")
    return plan, " ".join(notes) or None
