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
    assert read_date("this tuesday", today) == today
    assert read_date("due 2026-12-03", today) == date(2026, 12, 3)
    # An ISO date with a time: the "T" after the date stopped the match before.
    assert read_date("submit by 2026-11-28T10:00", today) == date(2026, 11, 28)
    assert read_date("2026-11-28T10:00:00Z", today) == date(2026, 11, 28)
    assert read_date("28 Nov", today) == date(2026, 11, 28)
    assert read_date("December 2nd", today) == date(2026, 12, 2)
    assert read_date("3 Jan", today) == date(2027, 1, 3)
    assert read_date("31 Feb", today) is None
    assert read_date("next week", today) is None
    assert read_date("mondays are long", today) is None


def test_next_weekday_is_not_taken_as_a_firm_date():
    # On a Tuesday, "next Friday" was read as this Friday (3 days ahead), though many people mean
    # the Friday of next week, so the deadline could be a week early.
    today = date(2026, 11, 24)  # a Tuesday
    assert read_date("next friday", today) is None
    assert read_date("next tuesday", today) is None
    # A later exact date in the same words still counts.
    assert read_date("next friday, the 4th of december", today) == date(2026, 12, 4)

    plan = build_demo_plan("Exam next Friday", NOW)
    task = plan.tasks[0]
    assert task.deadline is None
    assert "Confirm the date of the exam: your text says next Friday" in task.description

    meeting = build_demo_plan("A meeting next Friday", NOW)
    assert meeting.tasks[0].deadline is None
    assert "your text says next Friday" in meeting.tasks[0].description


def test_a_weekday_of_next_week_is_not_read_as_this_week():
    # "Friday next week" was read as this Friday, a week early: the week words were ignored.
    today = date(2026, 11, 24)  # a Tuesday; next week runs from Monday 30 Nov to Sunday 6 Dec
    assert read_date("friday next week", today) == date(2026, 12, 4)
    assert read_date("next week on friday", today) == date(2026, 12, 4)
    assert read_date("thursday of next week", today) == date(2026, 12, 3)
    assert read_date("monday next week", today) == date(2026, 11, 30)
    assert read_date("tuesday next week", today) == date(2026, 12, 1)
    assert read_date("this week on friday", today) == date(2026, 11, 27)
    # Other week words: not read, so the user is asked.
    for text in ("a week from friday", "friday after next", "friday in two weeks"):
        assert read_date(text, today) is None, text

    plan = build_demo_plan("Exam on Friday next week", NOW)
    assert plan.tasks[0].deadline == datetime(2026, 12, 4, 8, 0)
    unread = build_demo_plan("Exam the Friday after next", NOW)
    assert unread.tasks[0].deadline is None
    assert "the day in your text could not be read exactly" in unread.tasks[0].description


def test_an_exam_today_gets_no_deadline_that_has_already_passed():
    # "exam today" at 13:53 got the deadline today 08:00, already over when the task was made.
    plan = build_demo_plan("I have an exam today", NOW)
    task = plan.tasks[0]
    assert task.deadline is None
    assert "The exam: Tuesday 24 November." in task.description
    # Before 08:00 the morning of the exam is still ahead, so it stays the deadline.
    early = build_demo_plan("I have an exam today", datetime(2026, 11, 24, 7, 30))
    assert early.tasks[0].deadline == datetime(2026, 11, 24, 8, 0)
    # A date that is already over gets no deadline either.
    past = build_demo_plan("exam on 2026-11-20", NOW)
    assert past.tasks[0].deadline is None


def test_the_verb_may_is_not_read_as_the_month():
    # "may" followed or preceded by a number was read as a day in May: a firm deadline invented
    # from "i may 2 assignments" (2 May 2027) or "exam 1 may be moved" (1 May 2027).
    today = date(2026, 11, 24)
    for text in ("i may 2 assignments", "exam 1 may be moved", "assignment 2 may be late", "i may 3 times a week"):
        assert read_date(text, today) is None, text
    plan = build_demo_plan("I may 2 assignments", NOW)
    assert plan.tasks[0].deadline is None
    assert "Confirm the date of the assignments" in plan.tasks[0].description
    # The verb next to a real date: the real date is read.
    assert read_date("assignment 2 may be due friday", today) == date(2026, 11, 27)
    # The month is still read where the words mark a date.
    for text, expected in (
        ("exam on may 5", date(2027, 5, 5)),
        ("may 5", date(2027, 5, 5)),
        ("due 2 may", date(2027, 5, 2)),
        ("exam may 5 at 10", date(2027, 5, 5)),
        ("exam may 5 10:00", date(2027, 5, 5)),
        ("the exam is may 2nd", date(2027, 5, 2)),
        ("the 2nd of may", date(2027, 5, 2)),
        ("exam 1 may 2027", date(2027, 5, 1)),
        ("exam may 4, 2027", date(2027, 5, 4)),
        ("exam (may 5)", date(2027, 5, 5)),
        ("submit before 3 may", date(2027, 5, 3)),
    ):
        assert read_date(text, today) == expected, text
    # Other months need no such words.
    assert read_date("june 2 exam", today) == date(2027, 6, 2)


def test_a_bare_weekday_that_is_today_is_not_taken_as_a_firm_date():
    # "exam tuesday" said on a Tuesday was read as today, though many people mean next week's.
    today = date(2026, 11, 24)  # a Tuesday
    assert read_date("tuesday", today) is None
    assert read_date("exam on tuesday", today) is None
    # Words that make it this week's (today's) day still give today.
    assert read_date("this tuesday", today) == today
    assert read_date("this week on tuesday", today) == today
    assert read_date("tuesday this week", today) == today
    assert read_date("tuesday next week", today) == date(2026, 12, 1)
    # A later exact date in the same words still counts; other weekdays are unchanged.
    assert read_date("tuesday, 1 dec", today) == date(2026, 12, 1)
    assert read_date("wednesday", today) == date(2026, 11, 25)
    assert read_date("monday", today) == date(2026, 11, 30)

    plan = build_demo_plan("Exam Tuesday", NOW)
    task = plan.tasks[0]
    assert task.deadline is None
    assert "Confirm the date of the exam: your text says Tuesday, which can mean today or next Tuesday." in task.description

    meeting = build_demo_plan("A meeting on Tuesday", NOW)
    assert meeting.tasks[0].title == "Decide whether to reschedule the meeting"
    assert "your text says Tuesday, which can mean today or next Tuesday" in meeting.tasks[0].description
    # Not this hint when other week words decided it.
    unread = build_demo_plan("Exam Tuesday in two weeks", NOW)
    assert "the day in your text could not be read exactly" in unread.tasks[0].description


def test_a_may_date_left_out_is_named_and_capitals_or_an_ordinal_mark_the_month():
    # The verb guard dropped real May dates and then said "no date was found in your text",
    # although the text said "may 12"; "May" with a capital and "5th may" were not read either.
    today = date(2026, 11, 24)
    assert read_date("exam may 12 for chemistry", today) is None  # the guard stays for lower case
    plan = build_demo_plan("exam may 12 for chemistry", NOW)
    task = plan.tasks[0]
    assert task.deadline is None
    assert 'Confirm the date of the exam: your text says "may 12"; check whether it means 12 May.' in task.description
    assert "no date was found" not in task.description
    assignments = build_demo_plan("I may 2 assignments", NOW)
    assert 'your text says "may 2"; check whether it means 2 May.' in assignments.tasks[0].description

    # Written with a capital M, it is the month (the planner reads the text as the user wrote it).
    capital = build_demo_plan("Exam May 12 for chemistry", NOW)
    assert capital.tasks[0].deadline == datetime(2027, 5, 12, 8, 0)
    for text, expected in (
        ("exam May 12 for chemistry", date(2027, 5, 12)),
        ("chemistry exam May 5 room 201", date(2027, 5, 5)),
        ("exam scheduled May 5 hall b", date(2027, 5, 5)),
    ):
        assert read_date(text, today) == expected, text
    # An ordinal day before "may" counts like one after it ("may 5th"), unless the verb's usual
    # next word follows.
    assert read_date("exam 5th may is hard", today) == date(2027, 5, 5)
    assert read_date("the 5th may be the day", today) is None
    assert read_date("exam 1 May be moved", today) is None
    assert read_date("EXAM MAY 12 FOR CHEMISTRY", today) is None  # all capitals tell nothing


def test_after_an_unclear_day_another_day_word_is_not_taken_as_the_date():
    # "exam tuesday or wednesday" said on a Tuesday skipped Tuesday and gave Wednesday as a firm
    # deadline, though the user named two possible days.
    today = date(2026, 11, 24)  # a Tuesday
    for text in ("exam tuesday or wednesday", "exam tuesday or tomorrow", "exam next friday or saturday"):
        assert read_date(text, today) is None, text
    # A calendar or ISO date after it still counts.
    assert read_date("exam tuesday 1 dec", today) == date(2026, 12, 1)
    assert read_date("exam tuesday 2026-12-01", today) == date(2026, 12, 1)
    assert read_date("exam next friday 4 dec", today) == date(2026, 12, 4)

    plan = build_demo_plan("Exam Tuesday or Wednesday", NOW)
    assert plan.tasks[0].deadline is None
    assert "your text says Tuesday, which can mean today or next Tuesday" in plan.tasks[0].description


def test_a_weekday_after_this_week_is_not_this_weeks():
    # "this week" anywhere in the words made a bare weekday today, also in "after this week".
    today = date(2026, 11, 24)  # a Tuesday
    for text in ("meeting tuesday after this week", "tuesday following this week", "friday after this week"):
        assert read_date(text, today) is None, text
    assert read_date("tuesday is the meeting this week", today) == today
    assert read_date("this week on friday", today) == date(2026, 11, 27)


def test_the_reminder_for_an_undated_meeting_says_its_time_is_a_placeholder():
    # "A meeting on Tuesday" said on a Tuesday gets a reminder for tomorrow 09:00, too late if the
    # meeting is today; the reminder now says that its time is only a placeholder.
    reminder = next(action for action in build_demo_plan("A meeting on Tuesday", NOW).actions if action.action_type == "reminder")
    assert reminder.start_time == datetime(2026, 11, 25, 9, 0)
    assert "The meeting's date was not read, so this time is only a placeholder." in reminder.description
    dated = build_demo_plan("a meeting on friday", NOW)
    dated_reminder = next(action for action in dated.actions if action.action_type == "reminder")
    assert "placeholder" not in dated_reminder.description


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
