from app.models import ActionProposal, ActionType, RiskLevel


def requires_human_approval(action_type: str, risk_level: str) -> bool:
    # Email drafts are safe because they do not send.
    if action_type == ActionType.email_draft and risk_level == RiskLevel.low:
        return False

    if action_type in {ActionType.task, ActionType.reminder, ActionType.calendar_block}:
        return risk_level != RiskLevel.low

    return True


def can_auto_execute(action: ActionProposal) -> bool:
    if action.risk_level != RiskLevel.low:
        return False

    # Safe auto-execution in this MVP.
    return action.action_type in {
        ActionType.task,
        ActionType.reminder,
        ActionType.calendar_block,
        ActionType.email_draft,
    }
