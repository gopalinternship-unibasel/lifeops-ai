import pytest
from sqlalchemy.pool import NullPool

from app.db.session import build_engine, normalize_database_url


def test_sqlite_url_is_left_alone():
    assert normalize_database_url("sqlite:///./x.db") == "sqlite:///./x.db"
    engine = build_engine("sqlite:///./x.db")
    assert engine.dialect.name == "sqlite"
    assert not isinstance(engine.pool, NullPool)


@pytest.mark.parametrize("scheme", ["postgres", "postgresql", "postgresql+psycopg"])
def test_postgres_urls_use_the_psycopg_driver(scheme):
    url = normalize_database_url(f"{scheme}://u:p@host:5432/postgres?sslmode=require")
    assert url == "postgresql+psycopg://u:p@host:5432/postgres?sslmode=require"


def test_postgres_engine_holds_no_pool():
    engine = build_engine("postgresql://u:p@host:5432/postgres", schema="planner")
    assert engine.dialect.name == "postgresql"
    assert engine.dialect.driver == "psycopg"
    assert isinstance(engine.pool, NullPool)


def test_schema_name_must_be_a_plain_identifier():
    with pytest.raises(ValueError):
        build_engine("postgresql://u:p@host/db", schema='planner"; drop schema public; --')
