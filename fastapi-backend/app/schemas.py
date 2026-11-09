from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


ActionTypeLiteral = Literal["task", "calendar_block", "email_draft", "reminder"]
RiskLevelLiteral = Literal["low", "medium", "high"]


class PlanRequest(BaseModel):
    user_input: str = Field(..., min_length=3, max_length=4000)
    autonomous_mode: bool = False
    # Optional context from the caller: the user's local wall-clock time and IANA zone.
    # Planned times are naive local times in that zone.
    current_datetime: datetime | None = None
    timezone: str | None = Field(default=None, max_length=100)


class PlannerTask(BaseModel):
    title: str
    description: str | None = None
    deadline: datetime | None = None
    estimated_minutes: int = 60
    priority: int = Field(default=3, ge=1, le=5)


class PlannerAction(BaseModel):
    action_type: ActionTypeLiteral
    title: str
    description: str | None = None

    start_time: datetime | None = None
    end_time: datetime | None = None

    email_to: str | None = None
    email_subject: str | None = None
    email_body: str | None = None

    risk_level: RiskLevelLiteral = "low"
    requires_approval: bool = True


class PlannerOutput(BaseModel):
    summary: str
    tasks: list[PlannerTask]
    actions: list[PlannerAction]
    execution_order: list[str] = []


class PlanResponse(BaseModel):
    plan_run_id: int
    summary: str
    tasks_created: int
    actions_created: int
    executed_safe_actions: int
    plan: PlannerOutput
    # "llm" when the configured model planned, "demo" when the keyword planner did.
    planner: str = "demo"
    planner_note: str | None = None


class ExternalExecution(BaseModel):
    """Outcome of an approved action that the caller (the MONDAY app) carried out itself,
    for example a calendar block written to the user's calendar."""

    provider: str = Field(..., max_length=64)
    external_id: str | None = Field(default=None, max_length=256)
    result: dict | str | None = None


class AutonomousModeRequest(BaseModel):
    enabled: bool


class ActionExecutionResponse(BaseModel):
    action_id: int
    status: str
    provider: str | None = None
    result: dict | str | None = None
