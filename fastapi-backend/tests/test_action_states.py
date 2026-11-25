"""Action status changes (findings 73, 75, 82 and 109 of the 24 Nov 2026 audit).

- Executing an executed action replaced its recorded outcome and moved executed_at (73); for one
  that needed approval it answered "requires approval" while /approve said "already executed".
- Approve, reject and execute checked the status in Python and then wrote the whole row, so a
  Reject during a Run was overwritten and a second Run replaced the first external id (75).
- The built-in adapters stored "google_calendar" and "gmail" for mock runs (109) and called a
  reminder "recorded", though nothing reminds anyone (82).
"""

import json
import logging

import pytest
from sqlmodel import Session

import app.routes.actions as actions_route
from app.db.session import engine
from app.models import ActionProposal, ActionStatus
from test_api import ALICE, fake_llm, make_plan  # noqa: F401 - fixture

PLAN = {
    "summary": "s",
    "tasks": [],
    "actions": [
        {"action_type": "reminder", "title": "Water plants", "start_time": "2026-11-26T09:00:00", "risk_level": "low", "requires_approval": False},
        {
            "action_type": "calendar_block",
            "title": "Study",
            "start_time": "2026-11-26T09:00:00",
            "end_time": "2026-11-26T10:00:00",
            "risk_level": "high",
            "requires_approval": True,
        },
    ],
}


@pytest.fixture()
def two_actions(client, fake_llm):  # noqa: F811
    fake_llm.answer = json.dumps(PLAN)
    make_plan(client, text="water the plants and study")
    actions = client.get("/api/actions", headers=ALICE).json()
    return {action["title"]: action for action in actions}


def test_executing_again_keeps_the_recorded_outcome(client, two_actions):
    for action in two_actions.values():
        client.post(f"/api/actions/{action['id']}/approve", headers=ALICE)
        first = client.post(
            f"/api/actions/{action['id']}/execute",
            headers=ALICE,
            json={"provider": "demo_x", "external_id": "e1", "result": {"orig": True}},
        )
        assert first.status_code == 200, first.text
        before = client.get(f"/api/actions/{action['id']}", headers=ALICE).json()

        again = client.post(f"/api/actions/{action['id']}/execute", headers=ALICE)
        assert again.status_code == 200, again.text  # was 400 "requires approval" for the study block
        assert again.json()["result"]["status"] == "already_executed"
        # A retry with the same outcome (the first answer was lost) is the same answer.
        retry = client.post(
            f"/api/actions/{action['id']}/execute",
            headers=ALICE,
            json={"provider": "demo_x", "external_id": "e1", "result": {"orig": True}},
        )
        assert retry.status_code == 200
        after = client.get(f"/api/actions/{action['id']}", headers=ALICE).json()
        assert after == before  # execution_result and executed_at untouched


def test_a_second_different_outcome_is_refused_and_the_first_kept(client, two_actions):
    action = two_actions["Study"]
    client.post(f"/api/actions/{action['id']}/approve", headers=ALICE)
    client.post(f"/api/actions/{action['id']}/execute", headers=ALICE, json={"provider": "demo_calendar", "external_id": "evt-first"})
    second = client.post(
        f"/api/actions/{action['id']}/execute", headers=ALICE, json={"provider": "demo_calendar", "external_id": "evt-second"}
    )
    assert second.status_code == 409
    assert "not recorded" in second.json()["detail"]
    assert client.get(f"/api/actions/{action['id']}", headers=ALICE).json()["external_id"] == "evt-first"


def _change_status_meanwhile(monkeypatch, status: ActionStatus, external_id: str | None = None):
    """Make another request change the action's status between this request's read and write."""
    real = actions_route.record_external_execution

    def other_request_first(action, *args):
        with Session(engine) as other:
            row = other.get(ActionProposal, action.id)
            row.status = status
            row.external_id = external_id
            other.add(row)
            other.commit()
        return real(action, *args)

    monkeypatch.setattr(actions_route, "record_external_execution", other_request_first)


def test_a_reject_during_a_run_is_not_overwritten(client, two_actions, monkeypatch):
    action = two_actions["Study"]
    client.post(f"/api/actions/{action['id']}/approve", headers=ALICE)
    _change_status_meanwhile(monkeypatch, ActionStatus.rejected)
    response = client.post(
        f"/api/actions/{action['id']}/execute", headers=ALICE, json={"provider": "demo_calendar", "external_id": "evt-1"}
    )
    assert response.status_code == 409
    assert "rejected while it was being run" in response.json()["detail"]
    stored = client.get(f"/api/actions/{action['id']}", headers=ALICE).json()
    assert stored["status"] == "rejected" and stored["external_id"] is None


def test_of_two_overlapping_runs_the_first_outcome_stays(client, two_actions, monkeypatch):
    action = two_actions["Study"]
    client.post(f"/api/actions/{action['id']}/approve", headers=ALICE)
    _change_status_meanwhile(monkeypatch, ActionStatus.executed, external_id="evt-first")
    response = client.post(
        f"/api/actions/{action['id']}/execute", headers=ALICE, json={"provider": "demo_calendar", "external_id": "evt-second"}
    )
    assert response.status_code == 409
    assert client.get(f"/api/actions/{action['id']}", headers=ALICE).json()["external_id"] == "evt-first"


def _reject_while_the_adapter_runs(monkeypatch):
    """Make another request reject the action while the built-in adapter is running."""
    real = actions_route.execute_action

    def rejected_meanwhile(action):
        with Session(engine) as other:
            row = other.get(ActionProposal, action.id)
            row.status = ActionStatus.rejected
            other.add(row)
            other.commit()
        return real(action)

    monkeypatch.setattr(actions_route, "execute_action", rejected_meanwhile)


def test_execute_safe_leaves_an_action_another_request_changed(client, two_actions, monkeypatch, caplog):
    _reject_while_the_adapter_runs(monkeypatch)
    with caplog.at_level(logging.WARNING, logger="app.routes.actions"):
        result = client.post("/api/actions/execute-safe", headers=ALICE).json()
    assert result["executed_count"] == 0
    assert {"action_id": two_actions["Water plants"]["id"], "reason": "changed_meanwhile"} in result["skipped"]
    assert client.get(f"/api/actions/{two_actions['Water plants']['id']}", headers=ALICE).json()["status"] == "rejected"
    # The adapter had run: its outcome is not stored, but it is not lost without a trace either.
    assert f"Action {two_actions['Water plants']['id']} was changed by another request" in caplog.text
    assert "provider lifeops" in caplog.text


def test_an_adapter_run_that_lost_the_race_is_logged(client, two_actions, monkeypatch, caplog):
    study = two_actions["Study"]
    client.post(f"/api/actions/{study['id']}/approve", headers=ALICE)
    _reject_while_the_adapter_runs(monkeypatch)
    with caplog.at_level(logging.WARNING, logger="app.routes.actions"):
        response = client.post(f"/api/actions/{study['id']}/execute", headers=ALICE)
    assert response.status_code == 409
    assert client.get(f"/api/actions/{study['id']}", headers=ALICE).json()["status"] == "rejected"
    # Before, the external id of a write the adapter had already made was dropped silently.
    assert "provider mock_calendar, external id mock-calendar-" in caplog.text


def test_unchanged_refusals_keep_their_status_codes(client, two_actions):
    study = two_actions["Study"]
    assert client.post(f"/api/actions/{study['id']}/execute", headers=ALICE).status_code == 400  # needs approval
    client.post(f"/api/actions/{study['id']}/approve", headers=ALICE)
    client.post(f"/api/actions/{study['id']}/execute", headers=ALICE)
    assert client.post(f"/api/actions/{study['id']}/approve", headers=ALICE).json()["detail"] == "Action is already executed"
    assert client.post(f"/api/actions/{study['id']}/reject", headers=ALICE).json()["detail"] == "Executed actions cannot be rejected"
    plants = two_actions["Water plants"]
    assert client.post(f"/api/actions/{plants['id']}/reject", headers=ALICE).status_code == 200
    assert client.post(f"/api/actions/{plants['id']}/execute", headers=ALICE).status_code == 400


def test_mock_adapters_say_they_are_mock(client, two_actions):
    study = two_actions["Study"]
    client.post(f"/api/actions/{study['id']}/approve", headers=ALICE)
    result = client.post(f"/api/actions/{study['id']}/execute", headers=ALICE).json()
    assert result["provider"] == "mock_calendar"
    assert result["external_id"].startswith("mock-calendar-")


def test_a_reminder_run_by_the_planner_does_not_claim_to_be_scheduled(client, two_actions):
    plants = two_actions["Water plants"]
    result = client.post(f"/api/actions/{plants['id']}/execute", headers=ALICE).json()
    assert result["status"] == "executed"
    message = result["result"]["result"]["message"]
    assert "nothing will remind you" in message
    assert "recorded" not in message.lower()
