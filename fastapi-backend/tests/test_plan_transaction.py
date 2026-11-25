"""Storing a plan (findings 67, 74, 75 and 77 of the 24 Nov 2026 audit).

- A plan was committed piece by piece: a failure part way left the plan run, its tasks and the
  earlier actions stored while the caller got a 500 (67), for example an estimated_minutes too
  big for the column (74).
- Each commit and refresh opened a new database connection (NullPool on the hosted planner).
- The settings row was read after the model call, so its failure wasted the call (75).
- A repeated request stored a second plan (77): an optional idempotency key now returns the
  stored answer, and the caller's deadline caps the model call.
"""

import json
import logging
import re
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import event
from sqlalchemy.orm import Session as OrmSession
from sqlalchemy.pool import NullPool
from sqlmodel import Session, SQLModel, create_engine, func, select

import app.db.session as db_session
import app.routes.plan as plan_route
from app.db.session import engine
from app.main import app
from app.models import ActionProposal, AppSettings, PlanIdempotencyKey, PlanRun, Task
from test_api import ALICE, fake_llm  # noqa: F401 - fixture

TEXT = "Tomorrow I need to finish my report, email Anna about the meeting and schedule a gym session"


def _count(model) -> int:
    with Session(engine) as session:
        return session.exec(select(func.count()).select_from(model)).one()


def _llm_plan(*, minutes=60):
    return json.dumps(
        {
            "summary": "Report, Anna and the gym",
            "tasks": [{"title": "Finish the report", "estimated_minutes": minutes}],
            "actions": [
                {"action_type": "email_draft", "title": "Email Anna", "email_body": "Hi Anna", "risk_level": "low"},
                {
                    "action_type": "calendar_block",
                    "title": "Gym",
                    "start_time": "2026-11-25T18:00:00",
                    "end_time": "2026-11-25T19:00:00",
                    "risk_level": "low",
                },
            ],
        }
    )


def test_a_failure_while_storing_leaves_nothing_behind():
    def fail_on_actions(session, _context, _instances):
        if any(isinstance(item, ActionProposal) for item in session.new):
            raise RuntimeError("simulated database failure while storing the actions")

    event.listen(OrmSession, "before_flush", fail_on_actions)
    try:
        with TestClient(app, raise_server_exceptions=False) as client:
            response = client.post("/api/plan", json={"user_input": TEXT}, headers=ALICE)
    finally:
        event.remove(OrmSession, "before_flush", fail_on_actions)
    assert response.status_code == 500
    assert (_count(PlanRun), _count(Task), _count(ActionProposal)) == (0, 0, 0)


def test_a_huge_estimate_is_clamped_instead_of_failing_the_request(client, fake_llm):  # noqa: F811
    fake_llm.answer = _llm_plan(minutes=10**20)
    response = client.post("/api/plan", json={"user_input": TEXT}, headers=ALICE)
    assert response.status_code == 200, response.text
    assert client.get("/api/tasks", headers=ALICE).json()[0]["estimated_minutes"] == 1440


@pytest.fixture()
def nullpool_engine(monkeypatch):
    """The hosted planner's set-up: a new connection for every unit of work."""
    folder = Path(tempfile.mkdtemp(prefix="lifeops-nullpool-"))
    counted = create_engine(f"sqlite:///{(folder / 'nullpool.db').as_posix()}", poolclass=NullPool)
    SQLModel.metadata.create_all(counted)
    connects = []
    event.listen(counted, "connect", lambda *_: connects.append(1))
    monkeypatch.setattr(db_session, "engine", counted)
    return connects


def test_a_plan_opens_at_most_two_connections(nullpool_engine):
    with TestClient(app) as client:
        for user in ("first-time-user", "first-time-user"):
            nullpool_engine.clear()
            response = client.post("/api/plan", json={"user_input": TEXT + " exam"}, headers={"X-LifeOps-User": user})
            assert response.status_code == 200, response.text
            # One for the settings (released before the planner runs), one for the plan itself.
            assert len(nullpool_engine) <= 2, len(nullpool_engine)


def test_settings_are_read_before_the_model_is_called(fake_llm, monkeypatch):  # noqa: F811
    def broken(*_args, **_kwargs):
        raise RuntimeError("simulated database failure")

    monkeypatch.setattr(plan_route, "get_or_create_settings", broken)
    with TestClient(app, raise_server_exceptions=False) as client:
        assert client.post("/api/plan", json={"user_input": TEXT}, headers=ALICE).status_code == 500
    assert fake_llm.calls == []


def test_a_repeated_request_with_the_same_key_returns_the_stored_plan(client, fake_llm):  # noqa: F811
    fake_llm.answer = _llm_plan()
    body = {"user_input": TEXT, "idempotency_key": "plan-request-41"}
    first = client.post("/api/plan", json=body, headers=ALICE)
    again = client.post("/api/plan", json=body, headers=ALICE)
    assert first.status_code == again.status_code == 200
    assert again.json() == first.json()
    assert len(fake_llm.calls) == 1  # no second model call
    assert (_count(PlanRun), _count(Task), _count(ActionProposal)) == (1, 1, 2)
    # The key is per user: another user with the same key gets a plan of their own.
    other = client.post("/api/plan", json=body, headers={"X-LifeOps-User": "bob"})
    assert other.json()["plan_run_id"] != first.json()["plan_run_id"]
    # The same key for another text is a client mistake, not a repeat.
    clash = client.post("/api/plan", json={**body, "user_input": "Something else entirely"}, headers=ALICE)
    assert clash.status_code == 409
    # Without a key every request is planned and stored, as before.
    client.post("/api/plan", json={"user_input": TEXT}, headers=ALICE)
    assert _count(PlanRun) == 3


def test_a_duplicate_that_finishes_second_returns_the_first_plan(client, fake_llm, monkeypatch, caplog):  # noqa: F811
    fake_llm.answer = _llm_plan()
    body = {"user_input": TEXT, "idempotency_key": "plan-request-42"}
    first = client.post("/api/plan", json=body, headers=ALICE).json()

    # The second request checked for the key before the first one had stored it.
    real = plan_route._stored_answer
    calls = []

    def checked_too_early(*args):
        calls.append(1)
        return None if len(calls) == 1 else real(*args)

    monkeypatch.setattr(plan_route, "_stored_answer", checked_too_early)
    with caplog.at_level(logging.WARNING, logger="app.routes.plan"):
        second = client.post("/api/plan", json=body, headers=ALICE)
    assert second.status_code == 200, second.text
    assert second.json() == first
    assert (_count(PlanRun), _count(Task), _count(ActionProposal)) == (1, 1, 2)
    # Concurrent duplicates each call the model; the discarded second plan is logged.
    assert len(fake_llm.calls) == 2
    assert "same idempotency key ran at the same time" in caplog.text


def test_a_discarded_duplicate_names_its_plan_run_and_the_actions_it_ran(client, fake_llm, monkeypatch, caplog):  # noqa: F811
    # The discarded plan's rows are rolled back, and the database may give their ids to later
    # rows; the warning did not name them, so the executor's log lines about them were ambiguous.
    answer = json.loads(_llm_plan())
    for action in answer["actions"]:
        action["requires_approval"] = False  # low risk and no approval: run in autonomous mode
    fake_llm.answer = json.dumps(answer)
    body = {"user_input": TEXT, "idempotency_key": "plan-request-43", "autonomous_mode": True}
    first = client.post("/api/plan", json=body, headers=ALICE).json()

    real_stored, real_execute = plan_route._stored_answer, plan_route.execute_action
    checks, ran = [], []

    def checked_too_early(*args):
        checks.append(1)
        return None if len(checks) == 1 else real_stored(*args)

    def execute(action):
        ran.append(action.id)
        return real_execute(action)

    monkeypatch.setattr(plan_route, "_stored_answer", checked_too_early)
    monkeypatch.setattr(plan_route, "execute_action", execute)
    with caplog.at_level(logging.WARNING, logger="app.routes.plan"):
        second = client.post("/api/plan", json=body, headers=ALICE)
    assert second.json() == first
    assert len(ran) == 2 and None not in ran
    warning = next(record.getMessage() for record in caplog.records if "same idempotency key" in record.getMessage())
    assert f"adapters run for discarded actions {ran}" in warning
    assert f"the first (plan run {first['plan_run_id']}) returned" in warning
    discarded_run = re.search(r"the second plan \(plan run (\d+),", warning)
    assert discarded_run and int(discarded_run.group(1)) != first["plan_run_id"]


def test_stored_answers_older_than_two_days_are_deleted(client):
    with Session(engine) as session:
        session.add(
            PlanIdempotencyKey(
                owner="someone-deleted",
                idempotency_key="old",
                input_sha256="0" * 64,
                plan_run_id=1,
                response_json="{}",
                created_at=datetime.utcnow() - timedelta(days=3),
            )
        )
        session.commit()
    client.post("/api/plan", json={"user_input": "exam next week", "idempotency_key": "new"}, headers=ALICE)
    with Session(engine) as session:
        keys = session.exec(select(PlanIdempotencyKey.idempotency_key)).all()
    assert keys == ["new"]


def test_the_model_call_gets_at_most_the_time_left_before_the_deadline(client, fake_llm):  # noqa: F811
    fake_llm.answer = _llm_plan()
    deadline = (datetime.now(timezone.utc) + timedelta(seconds=30)).isoformat()
    response = client.post("/api/plan", json={"user_input": TEXT, "deadline": deadline}, headers=ALICE)
    assert response.status_code == 200, response.text
    timeout = fake_llm.calls[-1]["client"]["timeout"]
    assert 20 < timeout <= 28


def test_without_time_for_the_model_the_keyword_planner_answers_in_time(client, fake_llm):  # noqa: F811
    deadline = (datetime.now(timezone.utc) + timedelta(seconds=2.5)).isoformat()
    response = client.post("/api/plan", json={"user_input": "exam next week", "deadline": deadline}, headers=ALICE)
    assert response.status_code == 200, response.text
    assert fake_llm.calls == []
    assert response.json()["planner"] == "demo"
    assert "no time left" in response.json()["planner_note"]


def test_the_first_requests_of_a_new_user_do_not_collide_on_the_settings_row(client, monkeypatch):
    import app.routes.settings as settings_route

    real = settings_route._find_settings
    calls = []

    def other_request_inserts_first(session, owner):
        calls.append(1)
        if len(calls) == 1:
            # Another first request inserts the row between this request's SELECT and INSERT.
            with Session(engine) as other:
                other.add(AppSettings(owner=owner))
                other.commit()
            return None
        return real(session, owner)

    monkeypatch.setattr(settings_route, "_find_settings", other_request_inserts_first)
    response = client.post("/api/plan", json={"user_input": "exam next week"}, headers={"X-LifeOps-User": "carol"})
    assert response.status_code == 200, response.text
    assert _count(AppSettings) == 1
