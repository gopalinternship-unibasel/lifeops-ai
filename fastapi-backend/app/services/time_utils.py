from datetime import datetime, timedelta


def next_weekday_or_tomorrow(now: datetime | None = None) -> datetime:
    now = now or datetime.now()
    return (now + timedelta(days=1)).replace(hour=10, minute=0, second=0, microsecond=0)


def default_study_block_times(now: datetime | None = None):
    now = now or datetime.now()
    start = (now + timedelta(days=1)).replace(hour=9, minute=0, second=0, microsecond=0)
    end = start + timedelta(hours=2)
    return start, end


def default_assignment_block_times(now: datetime | None = None):
    now = now or datetime.now()
    start = (now + timedelta(days=1)).replace(hour=14, minute=0, second=0, microsecond=0)
    end = start + timedelta(hours=2)
    return start, end
