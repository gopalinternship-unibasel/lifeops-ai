import json
from types import SimpleNamespace

import pytest

from app.services import llm_planner

ALICE = {"X-LifeOps-User": "alice"}
BOB = {"X-LifeOps-User": "bob"}
MESSY = "I have exams next week, 2 assignments, and a meeting tomorrow"


def make_plan(client, headers=ALICE, text=MESSY):
    response = client.post("/api/plan", json={"user_input": text}, headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


class FakeOpenAI:
    """Stands in for openai.OpenAI; returns a canned chat completion and records the call."""

    calls: list[dict] = []
    answer: str = "{}"
    error: Exception | None = None

    def __init__(self, **kwargs):
        FakeOpenAI.calls.append({"client": kwargs})
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self._create))

    def _create(self, **kwargs):
        FakeOpenAI.calls[-1]["request"] = kwargs
        if FakeOpenAI.error:
            raise FakeOpenAI.error
        message = SimpleNamespace(content=FakeOpenAI.answer)
        return SimpleNamespace(choices=[SimpleNamespace(message=message)])


@pytest.fixture()
def fake_llm(monkeypatch, use_settings):
    FakeOpenAI.calls = []
    FakeOpenAI.answer = "{}"
    FakeOpenAI.error = None
    monkeypatch.setattr(llm_planner, "OpenAI", FakeOpenAI)
    use_settings(llm_base_url="http://llm.test/v1", llm_api_key="test-key", llm_model="test-model")
    return FakeOpenAI


def test_root_reports_keyword_planner_without_llm(client):
    body = client.get("/").json()
    assert body["status"] == "ok"
    assert body["planner"] == "demo"
    assert body["auth_required"] is False


def test_keyword_planner_turns_messy_input_into_tasks_and_actions(client):
    plan = make_plan(client)
    assert plan["planner"] == "demo"
    assert plan["tasks_created"] == 4
    assert plan["actions_created"] == 4
    kinds = sorted(action["action_type"] for action in plan["plan"]["actions"])
    assert kinds == ["calendar_block", "calendar_block", "email_draft", "reminder"]

    dashboard = client.get("/api/dashboard", headers=ALICE).json()
    assert dashboard["metrics"]["total_tasks"] == 4
    assert dashboard["metrics"]["pending_actions"] == 4
    # Highest priority first.
    assert dashboard["next_best_actions"][0]["title"] == "Prepare for upcoming exam"
    assert dashboard["last_plan"]["planner"] == "demo"


def test_workspaces_are_isolated_per_user(client):
    make_plan(client, headers=ALICE)
    assert client.get("/api/dashboard", headers=BOB).json()["metrics"]["total_tasks"] == 0
    alice_action = client.get("/api/actions", headers=ALICE).json()[0]
    assert client.post(f"/api/actions/{alice_action['id']}/approve", headers=BOB).status_code == 404


def test_shared_secret_is_enforced_when_configured(client, use_settings):
    use_settings(lifeops_backend_token="s3cret-test-token")
    assert client.get("/api/dashboard").status_code == 401
    assert client.get("/api/dashboard", headers={"Authorization": "Bearer wrong"}).status_code == 401
    assert client.get("/api/dashboard", headers={"Authorization": "Bearer s3cret-test-token"}).status_code == 200
    assert client.get("/api/dashboard", headers={"X-LifeOps-Token": "s3cret-test-token"}).status_code == 200
    assert client.get("/").status_code == 200  # health stays open


def test_high_risk_actions_need_approval_before_execution(client, fake_llm):
    fake_llm.answer = json.dumps(
        {
            "summary": "Reschedule the meeting",
            "tasks": [{"title": "Decide on the meeting", "priority": 4}],
            "actions": [
                {
                    "action_type": "calendar_block",
                    "title": "Move the team meeting",
                    "start_time": "2026-11-10T10:00:00",
                    "end_time": "2026-11-10T11:00:00",
                    "risk_level": "high",
                    "requires_approval": False,
                }
            ],
        }
    )
    plan = make_plan(client, text="Move tomorrow's team meeting")
    assert plan["planner"] == "llm"
    action = client.get("/api/actions", headers=ALICE).json()[0]
    assert action["requires_approval"] is True  # the model's "false" is overridden for high risk

    blocked = client.post(f"/api/actions/{action['id']}/execute", headers=ALICE)
    assert blocked.status_code == 400
    assert "requires approval" in blocked.json()["detail"]

    assert client.post(f"/api/actions/{action['id']}/approve", headers=ALICE).json()["status"] == "approved"
    executed = client.post(f"/api/actions/{action['id']}/execute", headers=ALICE).json()
    assert executed["status"] == "executed"


def test_rejected_actions_cannot_be_executed(client):
    make_plan(client)
    action = client.get("/api/actions", headers=ALICE).json()[0]
    assert client.post(f"/api/actions/{action['id']}/reject", headers=ALICE).json()["status"] == "rejected"
    assert client.post(f"/api/actions/{action['id']}/execute", headers=ALICE).status_code == 400
    assert client.post(f"/api/actions/{action['id']}/approve", headers=ALICE).status_code == 400


def test_outcome_of_externally_executed_action_is_recorded(client):
    make_plan(client)
    block = next(a for a in client.get("/api/actions", headers=ALICE).json() if a["action_type"] == "calendar_block")
    client.post(f"/api/actions/{block['id']}/approve", headers=ALICE)
    response = client.post(
        f"/api/actions/{block['id']}/execute",
        headers=ALICE,
        json={"provider": "demo_calendar", "external_id": "evt-123", "result": {"calendar": "demo"}},
    )
    assert response.status_code == 200, response.text
    stored = client.get(f"/api/actions/{block['id']}", headers=ALICE).json()
    assert stored["status"] == "executed"
    assert stored["provider"] == "demo_calendar"
    assert stored["external_id"] == "evt-123"
    # Executing again does not run it twice.
    again = client.post(f"/api/actions/{block['id']}/execute", headers=ALICE).json()
    assert again["result"]["status"] == "already_executed"


def test_email_actions_are_drafts_only(client):
    make_plan(client)
    draft = next(a for a in client.get("/api/actions", headers=ALICE).json() if a["action_type"] == "email_draft")
    assert draft["email_to"] is None  # never an invented address; the user fills it in
    client.post(f"/api/actions/{draft['id']}/approve", headers=ALICE)
    result = client.post(f"/api/actions/{draft['id']}/execute", headers=ALICE).json()
    assert result["provider"] == "gmail"
    assert result["external_id"].startswith("mock-gmail-draft-")


def test_execute_safe_skips_actions_that_need_a_human(client, fake_llm):
    fake_llm.answer = json.dumps(
        {
            "summary": "Two blocks",
            "tasks": [{"title": "Study"}],
            "actions": [
                {
                    "action_type": "reminder",
                    "title": "Water the plants",
                    "risk_level": "low",
                    "requires_approval": False,
                },
                {
                    "action_type": "calendar_block",
                    "title": "Study block",
                    "start_time": "2026-11-10T09:00:00",
                    "end_time": "2026-11-10T10:00:00",
                    "risk_level": "low",
                    "requires_approval": True,
                },
            ],
        }
    )
    make_plan(client, text="Remind me about the plants and block study time")
    result = client.post("/api/actions/execute-safe", headers=ALICE).json()
    assert result["executed_count"] == 1
    assert result["skipped_count"] == 1


def test_llm_answer_is_validated_item_by_item(client, fake_llm):
    fake_llm.answer = "```json\n" + json.dumps(
        {
            "summary": "Plan",
            "tasks": [
                {"title": "Write report", "priority": 9, "deadline": "next friday-ish"},
                {"title": "Call bank", "priority": 2},
            ],
            "actions": [
                {"action_type": "send_email", "title": "Send it now"},
                {
                    "action_type": "calendar_block",
                    "title": "Backwards block",
                    "start_time": "2026-11-10T12:00:00",
                    "end_time": "2026-11-10T11:00:00",
                },
                {
                    "action_type": "email_draft",
                    "title": "Draft to the bank",
                    "email_to": "bank@example.com",
                    "email_subject": "Question",
                    "email_body": "Hello",
                    "risk_level": "unknown",
                },
            ],
        }
    ) + "\n```"
    plan = make_plan(client, text="report and bank")
    assert plan["planner"] == "llm"
    titles = [task["title"] for task in plan["plan"]["tasks"]]
    assert titles == ["Write report", "Call bank"]
    assert plan["plan"]["tasks"][0]["priority"] == 5  # clamped
    assert [a["title"] for a in plan["plan"]["actions"]] == ["Draft to the bank"]
    assert plan["plan"]["actions"][0]["requires_approval"] is True  # unknown risk -> medium
    assert "send_email" in plan["planner_note"]
    assert "Backwards block" in plan["planner_note"]


def test_llm_request_uses_the_configured_openai_compatible_endpoint(client, fake_llm):
    fake_llm.answer = json.dumps({"summary": "ok", "tasks": [{"title": "One thing"}], "actions": []})
    response = client.post(
        "/api/plan",
        json={"user_input": "one thing", "current_datetime": "2026-11-09T08:30:00", "timezone": "Europe/Zurich"},
        headers=ALICE,
    )
    assert response.status_code == 200
    call = fake_llm.calls[-1]
    assert call["client"]["base_url"] == "http://llm.test/v1"
    assert call["client"]["api_key"] == "test-key"
    assert call["request"]["model"] == "test-model"
    assert call["request"]["response_format"]["type"] == "json_schema"
    assert "2026-11-09T08:30:00" in call["request"]["messages"][1]["content"]
    assert "Europe/Zurich" in call["request"]["messages"][1]["content"]


def test_llm_failure_falls_back_to_keyword_planner(client, fake_llm):
    fake_llm.error = RuntimeError("connection refused")
    plan = make_plan(client)
    assert plan["planner"] == "demo"
    assert "connection refused" in plan["planner_note"]
    assert plan["tasks_created"] == 4


def test_model_http_error_note_is_a_sentence_without_the_raw_body(client, fake_llm):
    import httpx
    from openai import APIStatusError

    request = httpx.Request("POST", "http://127.0.0.1:11434/v1/chat/completions")
    response = httpx.Response(503, request=request)
    fake_llm.error = APIStatusError(
        "Error code: 503 - {'error': {'message': 'QA double: model unavailable'}}",
        response=response,
        body={"error": {"message": "QA double: model unavailable"}},
    )
    plan = make_plan(client)
    assert plan["planner"] == "demo"
    assert "the model service answered HTTP 503: QA double: model unavailable" in plan["planner_note"]
    assert "{" not in plan["planner_note"] and "'error'" not in plan["planner_note"]


def test_planner_mode_keyword_skips_a_configured_llm(client, fake_llm, use_settings):
    use_settings(planner_mode="keyword")
    plan = make_plan(client)
    assert plan["planner"] == "demo"
    assert "PLANNER_MODE=keyword" in plan["planner_note"]
    assert fake_llm.calls == []


def test_env_file_with_a_byte_order_mark_is_read_completely():
    # Windows PowerShell 5.1 writes UTF-8 files with a BOM; the first key must still count.
    import tempfile
    from pathlib import Path

    from app.core.config import Settings

    env_file = Path(tempfile.mkdtemp(prefix="lifeops-env-")) / ".env"
    env_file.write_bytes(b"\xef\xbb\xbfFRONTEND_ORIGIN=http://bom.test\r\nLLM_MODEL=bom-model\r\n")
    loaded = Settings(_env_file=env_file)
    assert loaded.frontend_origin == "http://bom.test"
    assert loaded.llm_model == "bom-model"


def test_model_times_with_an_offset_are_read_as_local_wall_clock(client, fake_llm):
    # Seen with qwen2.5:3b on 9 Nov 2026: "18:00:00Z" for a block the user wanted at 18:00 local.
    # Mixed naive/offset times must not crash the comparison either.
    fake_llm.answer = json.dumps(
        {
            "summary": "Assignment",
            "tasks": [{"title": "Assignment", "deadline": "2026-11-13T17:00:00+02:00"}],
            "actions": [
                {
                    "action_type": "calendar_block",
                    "title": "Assignment work block",
                    "start_time": "2026-11-10T18:00:00Z",
                    "end_time": "2026-11-10T19:00:00",
                }
            ],
        }
    )
    plan = make_plan(client, text="assignment block tomorrow 18-19")
    assert plan["planner"] == "llm"
    action = plan["plan"]["actions"][0]
    assert action["start_time"] == "2026-11-10T18:00:00"
    assert action["end_time"] == "2026-11-10T19:00:00"
    assert plan["plan"]["tasks"][0]["deadline"] == "2026-11-13T17:00:00"
    assert "local times" in plan["planner_note"]


def test_request_lists_the_dates_of_the_coming_days(client, fake_llm):
    # QA round 3: "Block Thursday 2-4 pm" became a deadline on Tuesday; the model now gets the dates.
    fake_llm.answer = json.dumps({"summary": "ok", "tasks": [{"title": "Deep work"}], "actions": []})
    response = client.post(
        "/api/plan",
        json={"user_input": "Block Thursday 2-4 pm for deep work", "current_datetime": "2026-11-09T21:54:54", "timezone": "Europe/Zurich"},
        headers=ALICE,
    )
    assert response.status_code == 200
    content = fake_llm.calls[-1]["request"]["messages"][1]["content"]
    assert "Monday 2026-11-09 (today), Tuesday 2026-11-10 (tomorrow), Wednesday 2026-11-11, Thursday 2026-11-12" in content
    assert "calendar_block" in fake_llm.calls[-1]["request"]["messages"][0]["content"]


def test_reminder_with_an_empty_range_keeps_only_its_start(client, fake_llm):
    # QA round 3: "Call Mom reminder Tue, 10 Nov, 17:45 - 17:45".
    fake_llm.answer = json.dumps(
        {
            "summary": "Call mom",
            "tasks": [{"title": "Call mom"}],
            "actions": [
                {"action_type": "reminder", "title": "Call Mom", "start_time": "2026-11-10T17:45:00", "end_time": "2026-11-10T17:45:00", "risk_level": "low"}
            ],
        }
    )
    plan = make_plan(client, text="call mom tomorrow")
    action = plan["plan"]["actions"][0]
    assert action["start_time"] == "2026-11-10T17:45:00"
    assert action["end_time"] is None


def test_invented_email_addresses_are_not_kept(client, fake_llm):
    # QA round 4: "draft an email to Sam" came back addressed to sam@example.com, and the app
    # saved that as the draft's recipient.
    fake_llm.answer = json.dumps(
        {
            "summary": "Lunch",
            "tasks": [],
            "actions": [
                {"action_type": "email_draft", "title": "Lunch with Sam", "email_to": "sam@example.com", "email_body": "Hi Sam", "risk_level": "low"},
                {"action_type": "email_draft", "title": "Note to Ana", "email_to": "Ana@Uni.example", "email_body": "Hi Ana", "risk_level": "low"},
                {"action_type": "reminder", "title": "Call", "start_time": "2026-11-10T09:00:00", "email_to": "x@example.com", "risk_level": "low"},
            ],
        }
    )
    plan = make_plan(client, text="Draft an email to Sam about lunch, and one to ana@uni.example. Remind me to call.")
    to = {action["title"]: action["email_to"] for action in plan["plan"]["actions"]}
    assert to == {"Lunch with Sam": None, "Note to Ana": "Ana@Uni.example", "Call": None}
    assert "sam@example.com" in plan["planner_note"] and "Fill it in" in plan["planner_note"]
