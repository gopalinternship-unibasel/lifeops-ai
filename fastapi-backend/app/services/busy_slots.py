"""Keep a plan clear of the caller's calendar, and drop plans the caller stopped waiting for.

The MONDAY dashboard sends the user's busy times with each plan request. Neither planner (the
model or the keyword planner) is guaranteed to respect them: the keyword planner uses fixed
slots (tomorrow 10:00 was the seeded demo lecture), and a model can ignore the list. So after
planning, every calendar block and reminder that overlaps a busy time, or another block of the
same plan, is moved to the next free slot of the same length between 08:00 and 20:00, and the
planner note says so. Without this the proposals could only fail when the user ran them.

All times are naive local wall-clock times in the user's zone, as in the rest of the planner.
"""

from datetime import datetime, timedelta, timezone

from app.schemas import BusyInterval, PlannerOutput

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
) -> tuple[datetime, datetime] | None:
    """The first slot of `length` from `earliest` on, between 08:00 and 20:00, that overlaps nothing
    in `taken`; None when the next SEARCH_DAYS days have none."""
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
        if not _overlaps(candidate, end, taken):
            return candidate, end
        candidate += STEP
    return None


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
    for action, start, end in to_move:
        earliest = max(start, earliest_allowed) if earliest_allowed else start
        slot = next_free_slot(end - start, earliest, taken)
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
    return plan, " ".join(notes) or None
