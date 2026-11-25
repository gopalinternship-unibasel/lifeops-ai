"""Autonomous mode (finding 109), list order (finding 72) and the dashboard's bounded lists (finding 68)
of the 24 Nov 2026 audit."""

import json
from datetime import datetime

import pytest
from sqlmodel import Session

from app.db.session import engine
from app.models import ActionProposal, ActionStatus, Task, TaskStatus
from test_api import ALICE, fake_llm, make_plan  # noqa: F401 - fixture


def _block(requires_approval: bool) -> str:
    return json.dumps(
        {
            "summary": "s",
            "tasks": [],
            "actions": [
                {
                    "action_type": "calendar_block",
                    "title": "Study",
                    "start_time": "2026-11-26T09:00:00",
                    "end_time": "2026-11-26T10:00:00",
                    "risk_level": "low",
                    "requires_approval": requires_approval,
                }
            ],
        }
    )


@pytest.fixture()
def autonomous_on(client):
    assert client.post("/api/settings/autonomous-mode", json={"enabled": True}, headers=ALICE).status_code == 200


def test_autonomous_mode_respects_requires_approval(client, fake_llm, autonomous_on):  # noqa: F811
    fake_llm.answer = _block(requires_approval=True)
    plan = make_plan(client, text="study block")
    assert plan["executed_safe_actions"] == 0
    assert client.get("/api/actions", headers=ALICE).json()[0]["status"] == "pending"


def test_an_explicit_false_switches_autonomous_mode_off(client, fake_llm, autonomous_on):  # noqa: F811
    fake_llm.answer = _block(requires_approval=False)
    response = client.post("/api/plan", json={"user_input": "study block", "autonomous_mode": False}, headers=ALICE)
    assert response.json()["executed_safe_actions"] == 0
    assert client.get("/api/dashboard", headers=ALICE).json()["last_plan"]["autonomous_mode_used"] is False
    # Left out, the stored setting applies, and a low-risk action without approval still runs.
    plan = make_plan(client, text="study block")
    assert plan["executed_safe_actions"] == 1
    assert client.get("/api/dashboard", headers=ALICE).json()["last_plan"]["autonomous_mode_used"] is True


def _add(*rows):
    with Session(engine) as session:
        for row in rows:
            session.add(row)
        session.commit()


def test_task_list_order_is_the_same_on_every_database(client):
    _add(
        Task(owner="alice", title="done", status=TaskStatus.done, priority=5),
        Task(owner="alice", title="undated", status=TaskStatus.pending, priority=4),
        Task(owner="alice", title="dated", status=TaskStatus.pending, priority=4, deadline=datetime(2026, 11, 26)),
        Task(owner="alice", title="started", status=TaskStatus.in_progress, priority=3),
    )
    tasks = client.get("/api/tasks", headers=ALICE).json()
    # Before: SQLite sorted the status text alphabetically (done first) and undated tasks first.
    assert [task["title"] for task in tasks] == ["dated", "undated", "started", "done"]


def test_action_list_starts_with_what_needs_the_user(client):
    _add(
        *[
            ActionProposal(owner="alice", action_type="reminder", title=status.value, status=status)
            for status in (ActionStatus.rejected, ActionStatus.executed, ActionStatus.failed, ActionStatus.approved, ActionStatus.pending)
        ]
    )
    statuses = [action["status"] for action in client.get("/api/actions", headers=ALICE).json()]
    assert statuses == ["pending", "approved", "failed", "executed", "rejected"]


def test_dashboard_lists_are_bounded_but_the_metrics_count_everything(client):
    _add(
        *[ActionProposal(owner="alice", action_type="reminder", title=f"old {n}", status=ActionStatus.executed) for n in range(240)],
        *[ActionProposal(owner="alice", action_type="reminder", title=f"open {n}", status=ActionStatus.pending) for n in range(10)],
        *[Task(owner="alice", title=f"task {n}", status=TaskStatus.done if n % 2 else TaskStatus.pending) for n in range(30)],
    )
    dashboard = client.get("/api/dashboard", headers=ALICE).json()
    assert len(dashboard["actions"]) == 200  # the default
    assert dashboard["metrics"]["total_actions"] == 250
    assert dashboard["metrics"]["pending_actions"] == 10
    assert dashboard["metrics"]["executed_actions"] == 240
    assert (dashboard["metrics"]["total_tasks"], dashboard["metrics"]["pending_tasks"], dashboard["metrics"]["done_tasks"]) == (30, 15, 15)
    # Open items are never the ones cut off.
    small = client.get("/api/dashboard?limit=12", headers=ALICE).json()
    assert len(small["actions"]) == 12
    assert [action["status"] for action in small["actions"][:10]] == ["pending"] * 10
    assert all(task["status"] == "pending" for task in small["tasks"])
    assert len(client.get("/api/dashboard?limit=0", headers=ALICE).json()["actions"]) == 1
    assert len(client.get("/api/dashboard?limit=100000", headers=ALICE).json()["actions"]) == 250
    # The response keeps its shape.
    assert set(dashboard) == {"before", "after", "metrics", "last_plan", "next_best_actions", "tasks", "actions"}
    assert len(dashboard["next_best_actions"]) == 5
