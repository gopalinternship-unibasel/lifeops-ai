from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_name: str = "LifeOps AI Backend"
    env: str = "development"
    database_url: str = "sqlite:///./lifeops.db"
    frontend_origin: str = "http://localhost:5190"

    # Provider-agnostic LLM (any OpenAI-compatible chat-completions API).
    #   Local Ollama:   LLM_BASE_URL=http://localhost:11434/v1  LLM_MODEL=llama3.1:8b
    #   Hugging Face:   LLM_BASE_URL=https://router.huggingface.co/v1  LLM_API_KEY=hf_...
    #   OpenAI:         LLM_BASE_URL=https://api.openai.com/v1  LLM_API_KEY=sk-...
    # Leave LLM_BASE_URL (and OPENAI_API_KEY) unset to use the keyword demo planner.
    llm_base_url: str | None = None
    llm_api_key: str | None = None
    llm_model: str = "llama3.1:8b"
    llm_timeout_seconds: float = 120.0
    llm_max_tokens: int = 1200
    # "json_schema" = constrained decoding against the planner schema (Ollama, OpenAI);
    # "json_object" = plain JSON mode for providers without schema support.
    llm_response_format: str = "json_schema"
    # "auto" = use the LLM when one is configured; "keyword" = always the keyword demo planner.
    planner_mode: str = "auto"

    # Legacy setting from the hackathon build: an OpenAI key alone selects OpenAI.
    openai_api_key: str | None = None
    openai_model: str = "gpt-4o-mini"

    # Shared secret for server-to-server calls from the MONDAY app. When set, every /api
    # request must send "Authorization: Bearer <token>" (or "X-LifeOps-Token: <token>").
    lifeops_backend_token: str | None = None

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

    def llm_endpoint(self) -> tuple[str, str | None, str] | None:
        """(base_url, api_key, model) of the configured LLM, or None for the demo planner."""
        if self.planner_mode.strip().lower() == "keyword":
            return None
        if self.llm_base_url:
            return self.llm_base_url.rstrip("/"), self.llm_api_key, self.llm_model
        if self.openai_api_key:
            return "https://api.openai.com/v1", self.openai_api_key, self.openai_model
        return None


settings = Settings()
