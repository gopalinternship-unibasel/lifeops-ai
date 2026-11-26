"""The plan request carries the user's busy times and the caller's deadline (MONDAY dashboard).

Findings 66 and 77 of the 24 Nov 2026 audit: the keyword planner proposed the exam block at
tomorrow 10:00-12:00, exactly on the seeded demo lecture, so Run could only report an overlap;
and a plan finished after the app had stopped waiting was still stored next to the in-app
assistant's answer.
"""

from datetime import datetime, timedelta, timezone

from app.schemas import BusyInterval, PlannerAction, PlannerOutput
from app.services.busy_slots import deadline_passed, keep_clear_of_busy, next_free_slot

ALICE = {"X-LifeOps-User": "alice"}
EXAMPLE = (
    "Exams next week, two assignments due Friday, a meeting tomorrow I might need to move, "
    "and I keep forgetting to call the bank."
)
LECTURE = {"title": "Lecture - Distributed Systems", "start": "2026-11-25T10:00:00", "end": "2026-11-25T12:00:00"}


def _blocks(plan: dict) -> list[dict]:
    return [action for action in plan["plan"]["actions"] if action["action_type"] == "calendar_block"]


def _overlaps(block: dict, busy: dict) -> bool:
    return block["start_time"] < busy["end"] and busy["start"] < block["end_time"]


def test_keyword_plan_keeps_its_blocks_off_the_busy_lecture(client):
    response = client.post(
        "/api/plan",
        json={
            "user_input": EXAMPLE,
            "current_datetime": "2026-11-24T13:53:00",
            "timezone": "Europe/Zurich",
            "busy": [LECTURE],
        },
        headers=ALICE,
    )
    assert response.status_code == 200, response.text
    plan = response.json()
    blocks = _blocks(plan)
    assert blocks, "the example plans calendar blocks"
    for block in blocks:
        assert not _overlaps(block, LECTURE), block
    exam = next(block for block in blocks if "exam" in block["title"].lower())
    # Same length, right after the lecture, and not on top of the 14:00 assignment block.
    assert exam["start_time"].startswith("2026-11-25T12:00")
    assert exam["end_time"].startswith("2026-11-25T14:00")
    assert "overlapped your calendar" in plan["planner_note"]
    # The stored proposal has the moved time too.
    stored = [a for a in client.get("/api/actions", headers=ALICE).json() if a["title"] == exam["title"]]
    assert stored[0]["start_time"].startswith("2026-11-25T12:00")


def test_without_busy_times_the_plan_is_unchanged(client):
    response = client.post(
        "/api/plan",
        json={"user_input": EXAMPLE, "current_datetime": "2026-11-24T13:53:00", "timezone": "Europe/Zurich"},
        headers=ALICE,
    )
    assert response.status_code == 200, response.text
    exam = next(block for block in _blocks(response.json()) if "exam" in block["title"].lower())
    assert exam["start_time"].startswith("2026-11-25T10:00")
    assert response.json()["planner_note"] is None or "overlapped" not in response.json()["planner_note"]


def test_a_plan_ready_after_the_deadline_is_not_stored(client):
    past = (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat().replace("+00:00", "Z")
    response = client.post("/api/plan", json={"user_input": "Write the report", "deadline": past}, headers=ALICE)
    assert response.status_code == 504
    dashboard = client.get("/api/dashboard", headers=ALICE).json()
    assert dashboard["metrics"]["total_tasks"] == 0
    assert dashboard["metrics"]["total_actions"] == 0
    assert dashboard["last_plan"] is None


def test_a_plan_ready_before_the_deadline_is_stored(client):
    future = (datetime.now(timezone.utc) + timedelta(minutes=1)).isoformat().replace("+00:00", "Z")
    response = client.post("/api/plan", json={"user_input": "Write the report", "deadline": future}, headers=ALICE)
    assert response.status_code == 200, response.text
    assert client.get("/api/dashboard", headers=ALICE).json()["metrics"]["total_tasks"] >= 1


def test_deadline_without_offset_is_read_as_utc():
    now = datetime(2026, 11, 24, 12, 0, tzinfo=timezone.utc)
    assert deadline_passed(datetime(2026, 11, 24, 11, 59), now) is True
    assert deadline_passed(datetime(2026, 11, 24, 12, 1), now) is False
    assert deadline_passed(None, now) is False


def _block(title: str, start: str, end: str) -> PlannerAction:
    return PlannerAction(
        action_type="calendar_block",
        title=title,
        start_time=datetime.fromisoformat(start),
        end_time=datetime.fromisoformat(end),
    )


def test_blocks_of_one_plan_do_not_overlap_each_other_either():
    plan = PlannerOutput(
        summary="Plan",
        tasks=[],
        actions=[
            _block("Gym", "2026-11-25T18:00:00", "2026-11-25T19:00:00"),
            _block("Reading", "2026-11-25T18:30:00", "2026-11-25T19:30:00"),
        ],
    )
    busy = [BusyInterval(title="Dentist", start="2026-11-26T14:00:00", end="2026-11-26T15:30:00")]
    plan, note = keep_clear_of_busy(plan, busy, datetime(2026, 11, 24, 13, 0))
    gym, reading = plan.actions
    assert (gym.start_time, gym.end_time) == (datetime(2026, 11, 25, 18), datetime(2026, 11, 25, 19))
    assert reading.start_time >= gym.end_time or reading.end_time <= gym.start_time
    assert note and "'Reading'" in note


def test_a_reminder_on_a_busy_time_moves_by_fifteen_minute_steps():
    reminder = PlannerAction(action_type="reminder", title="Call the bank", start_time=datetime(2026, 11, 25, 10, 30))
    plan = PlannerOutput(summary="Plan", tasks=[], actions=[reminder])
    busy = [BusyInterval(title="Lecture", start="2026-11-25T10:00:00", end="2026-11-25T12:00:00")]
    plan, note = keep_clear_of_busy(plan, busy, datetime(2026, 11, 24, 13, 0))
    assert plan.actions[0].start_time == datetime(2026, 11, 25, 12, 0)
    assert plan.actions[0].end_time is None
    assert note and "Call the bank" in note


def test_no_free_slot_in_a_full_week_leaves_the_block_and_says_so():
    taken = [(datetime(2026, 11, 24, 0, 0), datetime(2026, 12, 9, 0, 0))]
    assert next_free_slot(timedelta(hours=2), datetime(2026, 11, 25, 10, 0), taken) is None
    plan = PlannerOutput(summary="Plan", tasks=[], actions=[_block("Study", "2026-11-25T10:00:00", "2026-11-25T12:00:00")])
    busy = [BusyInterval(title="Holiday", start="2026-11-24T00:00:00", end="2026-12-09T00:00:00")]
    plan, note = keep_clear_of_busy(plan, busy, datetime(2026, 11, 24, 9, 0))
    assert plan.actions[0].start_time == datetime(2026, 11, 25, 10, 0)
    assert note and "Found no free time" in note


def test_moved_blocks_never_start_in_the_past_or_outside_the_day_window():
    plan = PlannerOutput(summary="Plan", tasks=[], actions=[_block("Late", "2026-11-24T19:00:00", "2026-11-24T21:00:00")])
    busy = [BusyInterval(title="Dinner", start="2026-11-24T19:00:00", end="2026-11-24T20:00:00")]
    plan, _ = keep_clear_of_busy(plan, busy, datetime(2026, 11, 24, 18, 50))
    moved = plan.actions[0]
    # 20:00 is the latest end, so the two-hour block goes to the next morning at 08:00.
    assert (moved.start_time, moved.end_time) == (datetime(2026, 11, 25, 8), datetime(2026, 11, 25, 10))


# --- blocks of a task with a deadline stay before that deadline -----------------------------

from app.schemas import PlannerTask  # noqa: E402
from app.services.busy_slots import latest_free_slot_before, related_deadline  # noqa: E402


def _assignments_plan(block_start: str, block_end: str, deadline: str) -> PlannerOutput:
    return PlannerOutput(
        summary="Plan",
        tasks=[PlannerTask(title="Complete two assignments", deadline=datetime.fromisoformat(deadline))],
        actions=[_block("Assignment Deep Work", block_start, block_end)],
    )


def test_a_block_moves_to_a_free_slot_before_its_tasks_deadline_not_after_it():
    # Friday 27 Nov 11:59 is the deadline; the block was planned on top of a Thursday lecture, and
    # the rest of Thursday is busy after it. Thursday morning is free: the old search went on to
    # Monday, after the deadline.
    plan = _assignments_plan("2026-11-26T14:00:00", "2026-11-26T16:00:00", "2026-11-27T11:59:00")
    busy = [
        BusyInterval(title="Lecture", start="2026-11-26T13:00:00", end="2026-11-26T20:00:00"),
        BusyInterval(title="Away", start="2026-11-27T08:00:00", end="2026-12-01T09:00:00"),
    ]
    plan, note = keep_clear_of_busy(plan, busy, datetime(2026, 11, 26, 7, 0))
    block = plan.actions[0]
    assert block.end_time <= datetime(2026, 11, 27, 11, 59)
    assert (block.start_time, block.end_time) == (datetime(2026, 11, 26, 11, 0), datetime(2026, 11, 26, 13, 0))
    assert note and "Moved 'Assignment Deep Work'" in note


def test_an_earlier_slot_is_not_used_before_now():
    plan = _assignments_plan("2026-11-26T14:00:00", "2026-11-26T16:00:00", "2026-11-27T11:59:00")
    busy = [BusyInterval(title="Lecture", start="2026-11-26T13:00:00", end="2026-11-26T20:00:00")]
    # It is 12:00 on Thursday: 08:00-11:00 is over, and 12:00-13:00 is too short for two hours, so
    # the block goes to Friday morning, still before the deadline.
    plan, note = keep_clear_of_busy(plan, busy, datetime(2026, 11, 26, 12, 0))
    block = plan.actions[0]
    assert (block.start_time, block.end_time) == (datetime(2026, 11, 27, 8, 0), datetime(2026, 11, 27, 10, 0))


def test_with_no_free_time_before_the_deadline_the_block_stays_and_the_note_says_so():
    plan = _assignments_plan("2026-11-26T14:00:00", "2026-11-26T16:00:00", "2026-11-27T11:59:00")
    busy = [BusyInterval(title="Conference", start="2026-11-26T00:00:00", end="2026-11-28T00:00:00")]
    plan, note = keep_clear_of_busy(plan, busy, datetime(2026, 11, 26, 7, 0))
    block = plan.actions[0]
    assert (block.start_time, block.end_time) == (datetime(2026, 11, 26, 14), datetime(2026, 11, 26, 16))
    assert note and "no free time before the deadline" in note


def test_a_block_with_no_related_task_deadline_moves_forward_as_before():
    plan = PlannerOutput(
        summary="Plan",
        tasks=[PlannerTask(title="Renew passport", deadline=datetime(2026, 11, 27, 9, 0))],
        actions=[_block("Gym", "2026-11-26T14:00:00", "2026-11-26T15:00:00")],
    )
    busy = [BusyInterval(title="Lecture", start="2026-11-26T13:00:00", end="2026-11-26T20:00:00")]
    plan, note = keep_clear_of_busy(plan, busy, datetime(2026, 11, 26, 7, 0))
    assert plan.actions[0].start_time == datetime(2026, 11, 27, 8, 0)
    assert note and "Moved 'Gym'" in note


def test_related_deadline_matches_words_and_ignores_tasks_without_a_deadline():
    tasks = [
        PlannerTask(title="Call the bank", deadline=datetime(2026, 11, 27, 17, 0)),
        PlannerTask(title="Complete two assignments", deadline=None),
        PlannerTask(title="Finish the assignments report", deadline=datetime(2026, 11, 27, 11, 59)),
    ]
    assert related_deadline("Assignment Deep Work", tasks) == datetime(2026, 11, 27, 11, 59)
    assert related_deadline("Call the Bank", tasks) == datetime(2026, 11, 27, 17, 0)
    assert related_deadline("Gym", tasks) is None


def test_next_free_slot_with_a_deadline_returns_none_when_the_slot_would_end_after_it():
    assert next_free_slot(timedelta(hours=2), datetime(2026, 11, 26, 9, 0), [], datetime(2026, 11, 26, 10, 30)) is None
    assert next_free_slot(timedelta(hours=2), datetime(2026, 11, 26, 9, 0), [], datetime(2026, 11, 26, 11, 0)) == (
        datetime(2026, 11, 26, 9, 0),
        datetime(2026, 11, 26, 11, 0),
    )
    assert latest_free_slot_before(
        timedelta(hours=1), datetime(2026, 11, 26, 0, 0), datetime(2026, 11, 26, 14, 0), [(datetime(2026, 11, 26, 12, 0), datetime(2026, 11, 26, 14, 0))]
    ) == (datetime(2026, 11, 26, 11, 0), datetime(2026, 11, 26, 12, 0))


# --- second round: linking, blocks after the deadline, deadlines already over ----------------


def test_one_common_word_does_not_link_a_block_to_a_task():
    tasks = [PlannerTask(title="Team report", deadline=datetime(2026, 11, 26, 12, 30))]
    assert related_deadline("Lunch with team", tasks) is None
    assert related_deadline("Team sync prep", tasks) is None
    two_words = [PlannerTask(title="Team report draft", deadline=datetime(2026, 11, 26, 12, 30))]
    assert related_deadline("Team report", two_words) == datetime(2026, 11, 26, 12, 30)


def test_lunch_with_team_is_not_pulled_before_the_team_report_deadline():
    plan = PlannerOutput(
        summary="Plan",
        tasks=[PlannerTask(title="Team report", deadline=datetime(2026, 11, 26, 12, 30))],
        actions=[_block("Lunch with team", "2026-11-26T12:00:00", "2026-11-26T13:00:00")],
    )
    busy = [BusyInterval(title="Meeting", start="2026-11-26T12:00:00", end="2026-11-26T13:00:00")]
    plan, _ = keep_clear_of_busy(plan, busy, datetime(2026, 11, 26, 7, 0))
    assert plan.actions[0].start_time == datetime(2026, 11, 26, 13, 0)


def test_a_block_after_its_deadline_is_searched_from_now_not_from_its_own_day():
    # Saturday block for a task due Thursday 17:00; Saturday is full, Thursday is free.
    plan = _assignments_plan("2026-11-28T10:00:00", "2026-11-28T12:00:00", "2026-11-26T17:00:00")
    busy = [BusyInterval(title="Away", start="2026-11-28T00:00:00", end="2026-11-29T00:00:00")]
    plan, note = keep_clear_of_busy(plan, busy, datetime(2026, 11, 25, 9, 0))
    block = plan.actions[0]
    assert block.end_time <= datetime(2026, 11, 26, 17, 0)
    assert block.start_time >= datetime(2026, 11, 25, 9, 0)
    assert note and "no free time before the deadline" not in note


def test_a_deadline_that_is_over_moves_the_block_forward_and_says_so():
    plan = _assignments_plan("2026-11-26T14:00:00", "2026-11-26T16:00:00", "2026-11-26T09:00:00")
    busy = [BusyInterval(title="Lecture", start="2026-11-26T13:00:00", end="2026-11-26T20:00:00")]
    plan, note = keep_clear_of_busy(plan, busy, datetime(2026, 11, 26, 12, 0))
    assert plan.actions[0].start_time == datetime(2026, 11, 27, 8, 0)
    assert note and "deadline for 'Assignment Deep Work' has already passed" in note
