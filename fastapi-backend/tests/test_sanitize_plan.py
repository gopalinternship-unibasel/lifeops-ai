"""Repairing common model quirks instead of dropping items (finding 74 of the 24 Nov 2026 audit).

The hosted planner reads free JSON text from the model (LLM_RESPONSE_FORMAT=none), so null, "",
numbers as text and a single string where a list belongs all occur; sanitize_plan is the only
guard before the plan is stored.
"""

from datetime import datetime

from app.services.llm_planner import sanitize_plan


def test_sanitize_plan_repairs_common_model_quirks():
    data = {
        "tasks": [
            {"title": "A", "priority": 0, "estimated_minutes": 10**12},
            {"title": "B", "priority": "4.5", "estimated_minutes": 0},
            {"title": "  ", "priority": 3},
            {"title": "C", "priority": 4.7, "estimated_minutes": "90", "deadline": "2026-11-28", "description": " "},
            {"title": "D", "priority": True, "estimated_minutes": None, "deadline": ""},
            {"title": "E", "priority": 10**400, "estimated_minutes": float("-inf")},
            {"title": "F", "priority": float("nan"), "estimated_minutes": "1e400"},
        ],
        "actions": [
            {
                "action_type": "reminder",
                "title": "R",
                "start_time": "2026-11-25T18:00:00",
                "end_time": "",
                "risk_level": "low",
                "requires_approval": None,
            },
            {"action_type": "reminder", "title": "", "start_time": "2026-11-25T18:00:00"},
            {"action_type": "task", "title": "T", "risk_level": "low", "requires_approval": "false"},
        ],
        "execution_order": "Study first",
    }
    plan, notes = sanitize_plan(data, "plan my week")
    assert [t.title for t in plan.tasks] == ["A", "B", "C", "D", "E", "F"]  # the blank title is dropped
    a, b, c, d, e, f = plan.tasks
    assert a.priority == 1  # 0 is clamped, not replaced by the default 3
    assert a.estimated_minutes == 1440  # upper clamp; the column is a 32-bit integer
    assert b.priority == 5 and b.estimated_minutes == 5  # "4.5" rounds up; 0 is clamped
    assert c.priority == 5 and c.estimated_minutes == 90 and c.description is None
    assert c.deadline == datetime(2026, 11, 28, 23, 59)  # a date alone means by the end of that day
    assert d.priority == 3 and d.estimated_minutes == 60 and d.deadline is None
    assert e.priority == 5 and e.estimated_minutes == 5  # beyond the bounds: clamped
    assert f.priority == 3 and f.estimated_minutes == 1440  # NaN is unreadable; "1e400" is infinity
    assert [x.title for x in plan.actions] == ["R", "T"]  # not dropped for "" or null
    reminder, task = plan.actions
    assert reminder.requires_approval is True and reminder.end_time is None
    assert task.requires_approval is True  # "false" as text is not a decision
    assert plan.execution_order == ["Study first"]
    assert any("without a title" in note for note in notes)


def test_execution_order_keeps_only_text_steps():
    data = {"tasks": [{"title": "x"}], "actions": [], "execution_order": ["One", "", None, 2, "  "]}
    plan, _ = sanitize_plan(data)
    assert plan.execution_order == ["One", "2"]
    plan, _ = sanitize_plan({"tasks": [{"title": "x"}], "actions": [], "execution_order": {"a": 1}})
    assert plan.execution_order == []


def test_texts_are_cut_to_what_the_app_can_store():
    data = {
        "summary": "s" * 5000,
        "tasks": [{"title": "t" * 500}],
        "actions": [
            {
                "action_type": "email_draft",
                "title": "e" * 500,
                "description": "d" * 5000,
                "email_subject": "s" * 500,
                "email_body": "b" * 20000,
                "risk_level": "low",
            }
        ],
    }
    plan, _ = sanitize_plan(data)
    assert len(plan.summary) == 1000
    assert len(plan.tasks[0].title) == 200
    draft = plan.actions[0]
    # A calendar entry title holds 200 characters, its notes 2000; a draft subject 300, its body 12000.
    assert (len(draft.title), len(draft.description), len(draft.email_subject), len(draft.email_body)) == (
        200,
        2000,
        300,
        12000,
    )
