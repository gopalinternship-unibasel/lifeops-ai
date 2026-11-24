"""The planner's own docs (finding 95) and the removed leftovers (finding 117) of the 24 Nov 2026 audit.

.env.example recommended glm-4.7-flash for the hosted planner, which returned no text for plain
JSON (VERCEL_DEPLOYMENT.md), and the README gave a test count that was long out of date. The
hackathon's Next.js prototype (fastapi-backend/lifeos), time_utils.py and python-dateutil were
used by nothing.
"""

import importlib.util
import re
from pathlib import Path

import pytest

PLANNER = Path(__file__).resolve().parents[1]
DEPLOYMENT_DOC = PLANNER.parent / "VERCEL_DEPLOYMENT.md"


def _deployed_planner_setting(name: str) -> str:
    if not DEPLOYMENT_DOC.exists():
        pytest.skip("VERCEL_DEPLOYMENT.md is not next to fastapi-backend in this checkout")
    text = DEPLOYMENT_DOC.read_text(encoding="utf-8")
    section = text.split("### 3.2 Planner project", 1)[1].split("\n### ", 1)[0]
    match = re.search(rf"^\|\s*`{name}`\s*\|\s*`([^`]+)`", section, re.MULTILINE)
    assert match, f"{name} not found in the planner settings table"
    return match.group(1)


def test_env_example_names_the_deployed_planner_model():
    hosted = re.findall(r"^#\s+LLM_MODEL=(\S+)", (PLANNER / ".env.example").read_text(encoding="utf-8"), re.MULTILINE)
    assert hosted == [_deployed_planner_setting("LLM_MODEL")]


def test_env_example_hosted_block_turns_thinking_off():
    text = (PLANNER / ".env.example").read_text(encoding="utf-8")
    assert '#   LLM_EXTRA_BODY={"chat_template_kwargs":{"enable_thinking":false}}' in text
    assert "not yet run" not in text


def test_readme_states_no_test_count():
    readme = (PLANNER / "README.md").read_text(encoding="utf-8")
    assert not re.search(r"\b\d+ tests\b", readme)


def test_unused_leftovers_are_gone():
    assert importlib.util.find_spec("app.services.time_utils") is None
    assert not (PLANNER / "lifeos").exists()
    requirements = (PLANNER / "requirements.txt").read_text(encoding="utf-8").lower()
    assert "python-dateutil" not in requirements
    assert "lifeos" not in (PLANNER / ".vercelignore").read_text(encoding="utf-8")
