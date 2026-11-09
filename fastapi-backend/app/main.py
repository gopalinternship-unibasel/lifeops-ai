from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.core.config import settings
from app.db.session import create_db_and_tables
from app.routes import actions, dashboard, plan, settings as settings_route, tasks

app = FastAPI(title=settings.app_name)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.frontend_origin, "http://localhost:5173", "http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def on_startup():
    create_db_and_tables()


@app.get("/")
def root():
    return {
        "status": "ok",
        "app": settings.app_name,
        "docs": "/docs",
    }


app.include_router(plan.router)
app.include_router(tasks.router)
app.include_router(actions.router)
app.include_router(dashboard.router)
app.include_router(settings_route.router)
