import os
import sys
import tempfile
from pathlib import Path

import pytest

# Configure the app BEFORE it is imported: a throw-away SQLite file, no LLM (keyword planner),
# no shared secret. Environment variables take precedence over fastapi-backend/.env.
_tmp = Path(tempfile.mkdtemp(prefix="lifeops-tests-"))
# LIFEOPS_TEST_DATABASE_URL (and optionally LIFEOPS_TEST_DATABASE_SCHEMA) runs the same tests against
# a throw-away PostgreSQL database instead; it must be one that may be emptied.
os.environ["DATABASE_URL"] = os.environ.get("LIFEOPS_TEST_DATABASE_URL") or f"sqlite:///{(_tmp / 'test.db').as_posix()}"
os.environ["DATABASE_SCHEMA"] = os.environ.get("LIFEOPS_TEST_DATABASE_SCHEMA", "")
os.environ["ENV"] = "test"
os.environ["LLM_BASE_URL"] = ""
os.environ["OPENAI_API_KEY"] = ""
os.environ["LIFEOPS_BACKEND_TOKEN"] = ""

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient  # noqa: E402
from sqlmodel import SQLModel  # noqa: E402

from app.core.config import settings  # noqa: E402
from app.db.session import engine  # noqa: E402
from app.main import app  # noqa: E402


@pytest.fixture(autouse=True)
def fresh_database():
    SQLModel.metadata.drop_all(engine)
    SQLModel.metadata.create_all(engine)
    yield


@pytest.fixture()
def client():
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture()
def use_settings(monkeypatch):
    """Temporarily override attributes of the global settings object."""

    def apply(**values):
        for key, value in values.items():
            monkeypatch.setattr(settings, key, value)

    return apply
