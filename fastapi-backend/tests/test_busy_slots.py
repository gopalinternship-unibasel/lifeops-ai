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
