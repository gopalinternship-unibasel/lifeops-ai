"""The Zapier execution backend (finding 114 of the 24 Nov 2026 audit). It is not deployed
(EXECUTION_BACKEND=mock), but when switched on: missing settings gave bare 500s after the plan was
stored, reminders and tasks became "failed", and the model could call any Zapier tool unasked."""

import json
import logging
from types import SimpleNamespace

import pytest

import app.integrations.zapier_mcp as zapier
from app.main import warn_about_incomplete_zapier_setup, warn_about_unwired_google_adapters
from app.models import ActionProposal, ActionStatus
from app.services.action_executor import apply_execution_result, execute_action
from test_api import ALICE, fake_llm  # noqa: F401 - fixture

PLAN = {
    "summary": "s",
    "tasks": [],
    "actions": [
        {
            "action_type": "calendar_block",
            "title": "Meeting prep",
            "start_time": "2026-11-25T09:00:00",
            "end_time": "2026-11-25T10:00:00",
            "risk_level": "low",
            "requires_approval": False,
        },
        {"action_type": "email_draft", "title": "Draft", "email_body": "Hi", "risk_level": "low", "requires_approval": False},
        {"action_type": "reminder", "title": "Call the bank", "start_time": "2026-11-25T11:00:00", "risk_level": "low", "requires_approval": False},
    ],
}


@pytest.fixture()
def zapier_without_settings(use_settings):
    use_settings(execution_backend="zapier_mcp", openai_api_key=None, zapier_mcp_url=None, zapier_mcp_allowed_tools=None)


def test_missing_settings_fail_the_actions_not_the_request(client, fake_llm, zapier_without_settings):  # noqa: F811
    fake_llm.answer = json.dumps(PLAN)
    response = client.post("/api/plan", json={"user_input": "meeting tomorrow at 10", "autonomous_mode": True}, headers=ALICE)
    assert response.status_code == 200, response.text
    # Only the reminder ran; the two actions whose executor failed are not counted as run.
    assert response.json()["executed_safe_actions"] == 1
    actions = {action["title"]: action for action in client.get("/api/actions", headers=ALICE).json()}
    for title in ("Meeting prep", "Draft"):
        assert actions[title]["status"] == "failed"
        assert "Check the planner's Zapier settings" in json.loads(actions[title]["execution_result"])["error"]
    # A reminder has no Zapier tool: it is handled locally, not marked failed.
    assert actions["Call the bank"]["status"] == "executed"
    assert actions["Call the bank"]["provider"] == "lifeops"


def test_failures_in_an_autonomous_plan_are_logged_with_the_action_id(client, fake_llm, zapier_without_settings, use_settings, caplog):  # noqa: F811
    # The plan route ran the executor before the action had an id, so the warning read
    # "Zapier execution of action None failed" and could not be matched to the stored action.
    fake_llm.answer = json.dumps(PLAN)
    with caplog.at_level(logging.WARNING, logger="app.services.action_executor"):
        response = client.post("/api/plan", json={"user_input": "meeting tomorrow at 10", "autonomous_mode": True}, headers=ALICE)
    assert response.status_code == 200, response.text
    ids = {action["title"]: action["id"] for action in client.get("/api/actions", headers=ALICE).json()}
    messages = [record.getMessage() for record in caplog.records if record.name == "app.services.action_executor"]
    assert "action None" not in " ".join(messages)
    for title in ("Meeting prep", "Draft"):
        assert any(f"Zapier execution of action {ids[title]} failed" in message for message in messages), messages

    # The same for the built-in Google adapters that are not wired up.
    caplog.clear()
    use_settings(execution_backend="mock", google_integration_mode="real")
    with caplog.at_level(logging.WARNING, logger="app.services.action_executor"):
        client.post("/api/plan", json={"user_input": "meeting tomorrow at 10", "autonomous_mode": True}, headers=ALICE)
    messages = [record.getMessage() for record in caplog.records if record.name == "app.services.action_executor"]
    assert len(messages) == 2 and "action None" not in " ".join(messages), messages
    assert all(message.startswith("Built-in adapter for action ") for message in messages)


def test_execute_safe_counts_only_the_actions_that_ran(client, fake_llm, zapier_without_settings):  # noqa: F811
    # Since failures became a failed result instead of a 500, execute-safe reached them, and it
    # counted every stored result as executed: "executed_count 3" with two actions stored as failed.
    fake_llm.answer = json.dumps(PLAN)
    client.post("/api/plan", json={"user_input": "meeting tomorrow at 10", "autonomous_mode": False}, headers=ALICE)
    ids = {action["title"]: action["id"] for action in client.get("/api/actions", headers=ALICE).json()}
    result = client.post("/api/actions/execute-safe", headers=ALICE).json()
    assert result["executed_count"] == 1
    assert [item["action_id"] for item in result["executed"]] == [ids["Call the bank"]]
    assert result["failed_count"] == 2
    assert sorted(item["action_id"] for item in result["failed"]) == sorted([ids["Meeting prep"], ids["Draft"]])
    assert all(item["result"]["status"] == "failed" for item in result["failed"])
    assert result["skipped_count"] == 0


def test_reminder_and_task_are_not_sent_to_zapier(zapier_without_settings):
    for kind in ("reminder", "task"):
        action = ActionProposal(owner="alice", action_type=kind, title="x", risk_level="low")
        apply_execution_result(action, execute_action(action))
        assert action.status == ActionStatus.executed and action.provider == "lifeops"


class FakeResponsesClient:
    calls: list[dict] = []

    def __init__(self, **_kwargs):
        self.responses = SimpleNamespace(create=self._create)

    def _create(self, **kwargs):
        FakeResponsesClient.calls.append(kwargs)
        return SimpleNamespace(output_text="Created the draft.")


@pytest.fixture()
def fake_zapier(monkeypatch, use_settings):
    FakeResponsesClient.calls = []
    monkeypatch.setattr(zapier, "OpenAI", FakeResponsesClient)
    use_settings(execution_backend="zapier_mcp", openai_api_key="sk-test", zapier_mcp_url="https://mcp.test/x")
    return FakeResponsesClient


def test_only_the_named_zapier_tools_may_be_called(fake_zapier, use_settings):
    use_settings(zapier_mcp_allowed_tools=" gmail_create_draft , google_calendar_create_event ")
    action = ActionProposal(owner="alice", action_type="email_draft", title="Draft", email_to="ana@uni.example", risk_level="low")
    result = execute_action(action)
    assert result["status"] == "executed"
    tool = fake_zapier.calls[0]["tools"][0]
    assert tool["allowed_tools"] == ["gmail_create_draft", "google_calendar_create_event"]


def test_without_a_tool_list_nothing_is_called(fake_zapier, use_settings):
    use_settings(zapier_mcp_allowed_tools=None)
    action = ActionProposal(owner="alice", action_type="email_draft", title="Draft", email_to="ana@uni.example", risk_level="low")
    assert execute_action(action)["status"] == "failed"
    assert fake_zapier.calls == []


def test_start_up_names_the_missing_zapier_settings(zapier_without_settings, caplog):
    with caplog.at_level(logging.WARNING):
        warn_about_incomplete_zapier_setup()
    assert "OPENAI_API_KEY, ZAPIER_MCP_URL, ZAPIER_MCP_ALLOWED_TOOLS" in caplog.text


def test_unwired_google_adapters_fail_the_actions_not_the_request(client, fake_llm, use_settings, caplog):  # noqa: F811
    # The built-in Gmail and Calendar adapters raise NotImplementedError outside their mock mode;
    # before, that was a bare 500 after the plan had been stored.
    use_settings(google_integration_mode="real")
    fake_llm.answer = json.dumps(PLAN)
    response = client.post("/api/plan", json={"user_input": "meeting tomorrow at 10", "autonomous_mode": True}, headers=ALICE)
    assert response.status_code == 200, response.text
    assert response.json()["executed_safe_actions"] == 1
    actions = {action["title"]: action for action in client.get("/api/actions", headers=ALICE).json()}
    for title in ("Meeting prep", "Draft"):
        assert actions[title]["status"] == "failed"
        assert "stand-in (mock) mode" in json.loads(actions[title]["execution_result"])["error"]
    assert actions["Call the bank"]["status"] == "executed"

    with caplog.at_level(logging.WARNING):
        warn_about_unwired_google_adapters()
    assert "GOOGLE_INTEGRATION_MODE=real" in caplog.text
