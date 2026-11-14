from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_name: str = "LifeOps AI Backend"
    env: str = "development"
    # SQLite file by default (local use and tests). For PostgreSQL use a URL such as
    # postgresql+psycopg://USER:PASSWORD@HOST:5432/postgres?sslmode=require ("postgres://" and
    # "postgresql://" are accepted too). On a serverless host the URL should point at a pooler.
    database_url: str = "sqlite:///./lifeops.db"
    # PostgreSQL only: the schema that holds the planner's tables. Every connection puts it first
    # on its search_path. The schema must exist. Leave unset to use the role's own search_path.
    database_schema: str | None = None
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
    # "json_object" = plain JSON mode for providers without schema support;
    # "none" = no response_format at all (Cloudflare Workers AI lists JSON mode only for older
    # models): the prompt asks for JSON and the planner takes the first JSON object from the text.
    # Any other value is treated as "json_schema".
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
        # "utf-8-sig" also reads files that start with a UTF-8 byte-order mark (Windows
        # PowerShell 5.1 `Set-Content -Encoding utf8` writes one). With plain "utf-8" the BOM
        # sticks to the first key, which is then silently ignored.
        env_file_encoding="utf-8-sig",
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
