"""The keyword planner (finding 51 of the 24 Nov 2026 audit).

It matched "exam" inside "example", invented two assignments and fixed deadlines (now + 5, 6, 7
days) whatever the text said, claimed calendar blocks in every summary, and wrote "exam
preparation" into every meeting draft. Its results are stored as real tasks and actions.
"""

from datetime import date, datetime

from app.services.demo_planner import build_demo_plan, read_date

ALICE = {"X-LifeOps-User": "alice"}
# Tuesday 24 Nov 2026, 13:53 local time.
NOW = datetime(2026, 11, 24, 13, 53)


def test_keyword_planner_does_not_match_example_or_examine():
    plan = build_demo_plan("Give me an example agenda and examine the budget", NOW)
    assert not any("exam" in task.title.lower() for task in plan.tasks)
    assert not any(action.action_type == "calendar_block" for action in plan.actions)


def test_keywords_still_match_as_whole_words():
    plan = build_demo_plan("Examination on Friday. Assignment due 2026-11-30. Team meeting.", NOW)
    titles = [task.title for task in plan.tasks]
    assert titles == ["Prepare for the exam", "Finish the assignment", "Decide whether to reschedule the meeting"]


def test_keyword_planner_summary_matches_output():
    plan = build_demo_plan("Buy groceries and call the plumber", NOW)
    assert plan.actions == []
    assert "calendar blocks" not in plan.summary
    assert "found no exam, assignment or meeting" in plan.summary
    assert [task.title for task in plan.tasks] == ["Clarify responsibilities"]


def test_summary_counts_what_was_made():
    plan = build_demo_plan("Exam next week", NOW)
    assert len(plan.tasks) == 1 and len(plan.actions) == 1
    assert plan.summary.startswith("The keyword planner made 1 task and 1 proposed action from your text.")


def test_meeting_draft_does_not_invent_exam():
    plan = build_demo_plan("Move the team meeting", NOW)
    draft = next(action for action in plan.actions if action.action_type == "email_draft")
    assert "exam" not in draft.email_body.lower()
    assert "deadline" not in draft.email_body.lower()
    assert draft.email_to is None


def test_proposals_ask_only_for_what_the_approval_center_offers():
    # The approval center offers Approve, Reject, Run and a To field for drafts; it cannot move a
    # block or edit a draft (finding 44: the note asked for a recipient no screen could take).
    plan = build_demo_plan("Exam next week, an assignment and a meeting tomorrow", NOW)
    texts = [action.description or "" for action in plan.actions] + plan.execution_order
    assert not any("move or reject" in text.lower() or "on the draft" in text.lower() for text in texts)
    draft = next(action for action in plan.actions if action.action_type == "email_draft")
    assert "To field" in draft.description


def test_one_assignment_task_without_an_invented_deadline():
    plan = build_demo_plan("2 assignments to do", NOW)
    assert [task.title for task in plan.tasks] == ["Finish the assignments"]
    task = plan.tasks[0]
    assert task.deadline is None
    assert "Confirm the date" in task.description


def test_stated_dates_are_used_and_unknown_ones_stay_empty():
    plan = build_demo_plan(
        "I have an exam on Friday, the assignment is due 2026-11-30, and a meeting tomorrow", NOW
    )
    tasks = {task.title: task for task in plan.tasks}
    assert tasks["Prepare for the exam"].deadline == datetime(2026, 11, 27, 8, 0)
    assert tasks["Finish the assignment"].deadline == datetime(2026, 11, 30, 23, 59)
    meeting = tasks["Decide whether to reschedule tomorrow's meeting"]
    assert meeting.deadline == datetime(2026, 11, 25, 8, 0)
    reminder = next(action for action in plan.actions if action.action_type == "reminder")
    # Before the meeting, never after it (it used to be two days later at 09:00).
    assert reminder.start_time == datetime(2026, 11, 25, 8, 0)

    undated = build_demo_plan("I have exams next week", NOW)
    assert undated.tasks[0].deadline is None
    assert "next week" in undated.tasks[0].description


def test_no_study_block_after_an_exam_that_is_tomorrow():
    plan = build_demo_plan("exam tomorrow", NOW)
    assert plan.tasks[0].deadline == datetime(2026, 11, 25, 8, 0)
    assert not any(action.action_type == "calendar_block" for action in plan.actions)


def test_no_reminder_for_a_meeting_that_has_started_its_day():
    plan = build_demo_plan("meeting today", NOW)
    assert not any(action.action_type == "reminder" for action in plan.actions)
    assert plan.tasks[0].deadline is None  # 08:00 today has passed


def test_read_date_understands_simple_dates():
    today = date(2026, 11, 24)  # a Tuesday
    assert read_date("tomorrow", today) == date(2026, 11, 25)
    assert read_date("the day after tomorrow", today) == date(2026, 11, 26)
    assert read_date("tonight", today) == today
    assert read_date("on friday", today) == date(2026, 11, 27)
    assert read_date("tuesday", today) == today
    assert read_date("next tuesday", today) == date(2026, 12, 1)
    assert read_date("due 2026-12-03", today) == date(2026, 12, 3)
    assert read_date("28 Nov", today) == date(2026, 11, 28)
    assert read_date("December 2nd", today) == date(2026, 12, 2)
    assert read_date("3 Jan", today) == date(2027, 1, 3)
    assert read_date("31 Feb", today) is None
    assert read_date("next week", today) is None
    assert read_date("mondays are long", today) is None


def test_keyword_proposals_need_approval_and_are_never_run_automatically(client):
    # Its times are guesses: even with autonomous mode on, nothing becomes a calendar event or a
    # draft without the user's approval.
    client.post("/api/settings/autonomous-mode", json={"enabled": True}, headers=ALICE)
    response = client.post(
        "/api/plan", json={"user_input": "Exam next week and a meeting tomorrow"}, headers=ALICE
    )
    assert response.status_code == 200, response.text
    assert response.json()["executed_safe_actions"] == 0
    actions = client.get("/api/actions", headers=ALICE).json()
    assert actions and all(action["requires_approval"] and action["status"] == "pending" for action in actions)
    assert client.post("/api/actions/execute-safe", headers=ALICE).json()["executed_count"] == 0
