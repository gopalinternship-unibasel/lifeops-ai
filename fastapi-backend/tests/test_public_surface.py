"""What a hosted planner shows without the token (finding 110 of the 24 Nov 2026 audit).

ENV defaulted to "development", which turned on SQL logging with bound values (user text) when a
deployment left ENV out, and /docs, /openapi.json and the model name on '/' were public everywhere.
"""

from fastapi.testclient import TestClient

from app.core.config import Settings
from app.db import session as db_session
from app.main import create_app


def test_env_defaults_to_production(monkeypatch):
    monkeypatch.delenv("ENV", raising=False)
    loaded = Settings(_env_file=None)
    assert loaded.env == "production"
    assert loaded.sql_echo() is False
    assert loaded.public_docs() is False


def test_sql_logging_only_when_development_is_set():
    assert Settings(_env_file=None, env="development").sql_echo() is True
    for env in ("local", "production", "test", "Production "):
        assert Settings(_env_file=None, env=env).sql_echo() is False


def test_a_hosted_planner_does_not_publish_its_api_description(use_settings):
    use_settings(env="production")
    with TestClient(create_app()) as client:
        for path in ("/docs", "/redoc", "/openapi.json"):
            assert client.get(path).status_code == 404, path
        root = client.get("/").json()
        # The smoke check still reads status and planner.
        assert root["status"] == "ok" and root["planner"] in {"llm", "demo"}
        assert "llm_model" not in root and "docs" not in root


def test_a_local_run_keeps_the_api_description(use_settings):
    use_settings(env="local")
    with TestClient(create_app()) as client:
        assert client.get("/docs").status_code == 200
        assert client.get("/openapi.json").status_code == 200
        root = client.get("/").json()
        assert root["docs"] == "/docs" and "llm_model" in root


def test_the_engine_logs_no_sql_and_hides_values_outside_development():
    # The tests run with ENV=test (conftest.py).
    assert db_session.engine.echo is False
    assert db_session.engine.hide_parameters is True
