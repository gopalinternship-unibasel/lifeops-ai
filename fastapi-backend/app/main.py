from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.core.config import settings
from app.core.security import require_backend_token
from app.db.session import create_db_and_tables
from app.routes import actions, dashboard, plan, settings as settings_route, tasks

app = FastAPI(title=settings.app_name)

app.add_middleware(
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


@app.on_event("startup")
def on_startup():
    create_db_and_tables()


@app.get("/")
def root():
    endpoint = settings.llm_endpoint()
    return {
        "status": "ok",
        "app": settings.app_name,
        "docs": "/docs",
        "planner": "llm" if endpoint else "demo",
        "llm_model": endpoint[2] if endpoint else None,
        "auth_required": bool(settings.lifeops_backend_token),
    }


_api = [Depends(require_backend_token)]
app.include_router(plan.router, dependencies=_api)
app.include_router(tasks.router, dependencies=_api)
app.include_router(actions.router, dependencies=_api)
app.include_router(dashboard.router, dependencies=_api)
app.include_router(settings_route.router, dependencies=_api)
