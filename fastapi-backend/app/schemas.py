from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


ActionTypeLiteral = Literal["task", "calendar_block", "email_draft", "reminder"]
RiskLevelLiteral = Literal["low", "medium", "high"]


class PlanRequest(BaseModel):
    user_input: str = Field(..., min_length=3)
    autonomous_mode: bool = False


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


class AutonomousModeRequest(BaseModel):
    enabled: bool


class ActionExecutionResponse(BaseModel):
    action_id: int
    status: str
    provider: str | None = None
    result: dict | str | None = None
