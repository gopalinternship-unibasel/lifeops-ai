from datetime import datetime
from enum import Enum
from typing import Optional

from sqlmodel import Field, SQLModel


class TaskStatus(str, Enum):
    pending = "pending"
    in_progress = "in_progress"
    done = "done"


class ActionStatus(str, Enum):
    pending = "pending"
    approved = "approved"
    executed = "executed"
    rejected = "rejected"
    failed = "failed"


class ActionType(str, Enum):
    task = "task"
    calendar_block = "calendar_block"
    email_draft = "email_draft"
    reminder = "reminder"


class RiskLevel(str, Enum):
    low = "low"
    medium = "medium"
    high = "high"


class AppSettings(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    # One settings row per workspace owner (the MONDAY user id, or "local").
    owner: str = Field(default="local", index=True, unique=True)
    autonomous_mode: bool = False
    updated_at: datetime = Field(default_factory=datetime.utcnow)


class Task(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    owner: str = Field(default="local", index=True)
    title: str
    description: Optional[str] = None
    deadline: Optional[datetime] = None
    estimated_minutes: int = 60
    priority: int = 3
    status: TaskStatus = TaskStatus.pending
    source: str = "manual_or_ai"
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)


class ActionProposal(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    owner: str = Field(default="local", index=True)

    action_type: ActionType
    title: str
    description: Optional[str] = None

    # Calendar/reminder fields
    start_time: Optional[datetime] = None
    end_time: Optional[datetime] = None

    # Email draft fields
    email_to: Optional[str] = None
    email_subject: Optional[str] = None
    email_body: Optional[str] = None

    # Safety state
    risk_level: RiskLevel = RiskLevel.low
    requires_approval: bool = True
    status: ActionStatus = ActionStatus.pending

    # Execution metadata
    provider: Optional[str] = None
    external_id: Optional[str] = None
    execution_result: Optional[str] = None

    created_at: datetime = Field(default_factory=datetime.utcnow)
    executed_at: Optional[datetime] = None


class PlanRun(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    owner: str = Field(default="local", index=True)
    user_input: str
    summary: str
    autonomous_mode_used: bool = False
    # "llm" when the configured model produced the plan, "demo" for the keyword planner.
    planner: str = "demo"
    created_at: datetime = Field(default_factory=datetime.utcnow)
