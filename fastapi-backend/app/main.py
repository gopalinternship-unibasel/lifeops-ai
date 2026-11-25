import logging

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from openai import OpenAI

from app.core.config import settings
from app.core.security import accepted_backend_tokens, require_backend_token
from app.db.session import create_db_and_tables
from app.routes import actions, dashboard, plan, settings as settings_route, tasks

logger = logging.getLogger(__name__)


def warn_about_incomplete_zapier_setup() -> None:
    """The Zapier executor needs three settings; say at start-up which are missing, so an operator
    does not find out from failed actions."""
    if settings.execution_backend != "zapier_mcp":
        return
    missing = [
        name
        for name, value in (
            ("OPENAI_API_KEY", settings.openai_api_key),
            ("ZAPIER_MCP_URL", settings.zapier_mcp_url),
            ("ZAPIER_MCP_ALLOWED_TOOLS", settings.zapier_tools()),
        )
        if not value
    ]
    if missing:
        logger.warning(
            "EXECUTION_BACKEND=zapier_mcp but %s is not set: calendar and draft actions will fail.",
            ", ".join(missing),
        )
    if not hasattr(OpenAI, "responses"):
        logger.warning(
            "EXECUTION_BACKEND=zapier_mcp needs the OpenAI Responses API, which the installed openai "
            "package does not have: calendar and draft actions will fail until it is upgraded."
        )


def warn_about_unwired_google_adapters() -> None:
    """The built-in Gmail and Calendar adapters only have their mock mode; any other
    GOOGLE_INTEGRATION_MODE makes the actions they run fail, which an operator should hear at once."""
    if settings.execution_backend == "zapier_mcp" or settings.google_integration_mode == "mock":
        return
    logger.warning(
        "GOOGLE_INTEGRATION_MODE=%s: the planner's own Gmail and Calendar adapters exist only as mock, "
        "so calendar and draft actions it runs itself will fail. Set GOOGLE_INTEGRATION_MODE=mock.",
        settings.google_integration_mode,
    )


def create_app() -> FastAPI:
    # The API description (/docs, /redoc, /openapi.json) is for local work only. A hosted planner
    # is called by the MONDAY app's server alone and does not publish its route list.
    docs = settings.public_docs()
    application = FastAPI(
        title=settings.app_name,
        docs_url="/docs" if docs else None,
        redoc_url="/redoc" if docs else None,
        openapi_url="/openapi.json" if docs else None,
    )

    application.add_middleware(
        CORSMiddleware,
        allow_origins=sorted(
            {
                settings.frontend_origin,
                "http://localhost:5190",
                "http://localhost:5173",
                "http://localhost:3000",
            }
        ),
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @application.on_event("startup")
    def on_startup():
        create_db_and_tables()
        warn_about_incomplete_zapier_setup()
        warn_about_unwired_google_adapters()

    @application.get("/")
    def root():
        endpoint = settings.llm_endpoint()
        body = {
            "status": "ok",
            "app": settings.app_name,
            # The smoke check reads "planner" to see that a model is configured.
            "planner": "llm" if endpoint else "demo",
            "auth_required": bool(accepted_backend_tokens()),
        }
        if docs:
            body["docs"] = "/docs"
            body["llm_model"] = endpoint[2] if endpoint else None
        return body

    api = [Depends(require_backend_token)]
    application.include_router(plan.router, dependencies=api)
    application.include_router(tasks.router, dependencies=api)
    application.include_router(actions.router, dependencies=api)
    application.include_router(dashboard.router, dependencies=api)
    application.include_router(settings_route.router, dependencies=api)
    return application


app = create_app()
