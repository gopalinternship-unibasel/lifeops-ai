from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_name: str = "LifeOps AI Backend"
    env: str = "development"
    database_url: str = "sqlite:///./lifeops.db"
    frontend_origin: str = "http://localhost:3000"

    openai_api_key: str | None = None
    openai_model: str = "gpt-4o-mini"

    autonomous_mode_default: bool = False

    # Keep this as mock because Zapier performs the real Gmail/Calendar actions.
    google_integration_mode: str = "mock"
    google_timezone: str = "Europe/Berlin"

    # Zapier MCP settings
    execution_backend: str = "mock"
    zapier_mcp_url: str | None = None
    zapier_mcp_auth_token: str | None = None

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )


settings = Settings()