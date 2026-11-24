"""The plan's note is shown to the user (finding 70 of the 24 Nov 2026 audit).

Parser and Python messages ("Expecting ',' delimiter: ...", "list index out of range") and setting
names ("LLM_BASE_URL", "PLANNER_MODE") reached the dashboard, and an answer cut off at the token
limit was reported as a JSON error.
"""

import json
from types import SimpleNamespace

import httpx
import pytest
from openai import APIConnectionError, APITimeoutError

from app.services import llm_planner
from app.services.llm_planner import PlannerAnswerError, readable_failure

ALICE = {"X-LifeOps-User": "alice"}
RAW_TEXTS = ("Expecting", "char ", "list index", "line 1", "column", "LLM_BASE_URL", "PLANNER_MODE", "Traceback")


class ScriptedOpenAI:
    """Stands in for openai.OpenAI and answers with the response set on the class."""

    response = None
    calls = 0

    def __init__(self, **_kwargs):
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self._create))

    def _create(self, **_kwargs):
        ScriptedOpenAI.calls += 1
        return ScriptedOpenAI.response


def _answer(content, finish_reason="stop"):
    return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=content), finish_reason=finish_reason)])


@pytest.fixture()
def scripted(monkeypatch, use_settings):
    ScriptedOpenAI.calls = 0
    monkeypatch.setattr(llm_planner, "OpenAI", ScriptedOpenAI)
    use_settings(llm_base_url="http://llm.test/v1", llm_api_key="k", llm_model="m", planner_mode="auto")
    return ScriptedOpenAI


def _note(client) -> str:
    response = client.post("/api/plan", json={"user_input": "I have an exam next week"}, headers=ALICE)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["planner"] == "demo"
    for raw in RAW_TEXTS:
        assert raw not in body["planner_note"], body["planner_note"]
    return body["planner_note"]


def test_cut_off_answer_says_so(client, scripted):
    scripted.response = _answer('{"summary": "Plan", "tasks": [{"title": "x"', finish_reason="length")
    assert "cut off" in _note(client)


def test_answer_that_used_the_whole_budget_on_thinking(client, scripted):
    scripted.response = _answer(None, finish_reason="length")
    assert "used up its length limit before it answered" in _note(client)


def test_empty_answer_says_so(client, scripted):
    scripted.response = SimpleNamespace(choices=[])
    assert "empty answer" in _note(client)


def test_prose_answer_is_not_a_readable_plan(client, scripted):
    scripted.response = _answer("I cannot help with that.")
    assert "not a readable plan" in _note(client)


def test_plan_with_nothing_usable_keeps_its_sentence(client, scripted):
    scripted.response = _answer(json.dumps({"summary": "s", "tasks": [], "actions": [{"action_type": "send_email"}]}))
    assert "no usable tasks or actions" in _note(client)


def test_no_model_configured_names_no_settings(client, use_settings):
    use_settings(planner_mode="keyword")
    note = _note(client)
    assert note == "No AI model is set up for the planner, so the keyword planner made this plan."


def test_readable_failure_maps_errors_to_fixed_phrases():
    request = httpx.Request("POST", "http://llm.test/v1/chat/completions")
    assert readable_failure(APIConnectionError(request=request)) == "the model service could not be reached"
    assert readable_failure(APITimeoutError(request=request), 41.6) == "the model did not answer within 42 s"
    assert readable_failure(json.JSONDecodeError("Expecting value", "x", 0)) == "the model's answer was not a readable plan"
    assert readable_failure(IndexError("list index out of range")) == "the model call failed"
    assert readable_failure(PlannerAnswerError("the model returned an empty answer")) == "the model returned an empty answer"
