import re

from sqlalchemy import event
from sqlalchemy.engine import Engine
from sqlalchemy.pool import NullPool
from sqlmodel import SQLModel, Session, create_engine

from app.core.config import settings

_SCHEMA_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,62}$")


def normalize_database_url(url: str) -> str:
    """Give PostgreSQL URLs the psycopg 3 driver (the one in requirements.txt).

    Hosting dashboards hand out "postgres://..." or "postgresql://..."; SQLAlchemy would read
    both as the psycopg2 driver, which is not installed.
    """
    for prefix in ("postgres://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+psycopg://" + url[len(prefix):]
    return url


def build_engine(
    url: str,
    *,
    schema: str | None = None,
    echo: bool = False,
    hide_parameters: bool = False,
) -> Engine:
    """SQLite stays as it was (local default and tests). PostgreSQL is made for serverless use.

    A serverless instance should not hold a connection pool of its own: the database side has a
    pooler (Supabase's Supavisor), so each unit of work opens a connection and closes it again
    (NullPool). With `schema` set, every new connection puts that schema first on its search_path.
    `hide_parameters` keeps bound values (user text) out of logged database errors.
    """
    url = normalize_database_url(url)
    if url.startswith("sqlite"):
        return create_engine(
            url,
            echo=echo,
            hide_parameters=hide_parameters,
            connect_args={"check_same_thread": False},
        )

    engine = create_engine(url, echo=echo, hide_parameters=hide_parameters, poolclass=NullPool)
    if schema:
        if not _SCHEMA_RE.match(schema):
            raise ValueError("DATABASE_SCHEMA must be a plain identifier (letters, digits, underscore).")

        @event.listens_for(engine, "connect")
        def _set_search_path(dbapi_connection, _record):
            cursor = dbapi_connection.cursor()
            try:
                cursor.execute(f'SET search_path TO "{schema}"')
            finally:
                cursor.close()
            dbapi_connection.commit()

    return engine


engine = build_engine(
    settings.database_url,
    schema=(settings.database_schema or "").strip() or None,
    echo=settings.sql_echo(),
    hide_parameters=not settings.sql_echo(),
)


def create_db_and_tables() -> None:
    SQLModel.metadata.create_all(engine)


def get_session():
    # expire_on_commit=False: objects keep their loaded values after a commit. With the default,
    # every attribute read after a commit reloaded the row, and with NullPool each reload opened a
    # new connection to the pooler (TCP, TLS and SET search_path) for values already in memory.
    with Session(engine, expire_on_commit=False) as session:
        yield session
