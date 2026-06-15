from pydantic_settings import BaseSettings
from pydantic import model_validator
from functools import lru_cache

_INSECURE_SECRETS = {
    "local-dev-secret-change-in-production",
    "local-dev-secret",
    "changeme",
    "secret",
}


class Settings(BaseSettings):
    # ── Database ────────────────────────────────────────────────────────────
    database_url: str = "postgresql+asyncpg://nexus:nexusdev@db:5432/nexus_agent"

    # ── Provider switches ────────────────────────────────────────────────────
    # local | gcs
    storage_provider: str = "local"
    # local | vertexai
    embedding_provider: str = "local"

    # ── Local auth ──────────────────────────────────────────────────────────
    local_jwt_secret: str = "local-dev-secret-change-in-production"
    local_jwt_expire_hours: int = 30  # reduced from 72 h — limit stolen-token window

    initial_admin_email: str = "admin@nexus.local"
    initial_admin_password: str = "ChangeMe123!"

    # ── Local storage ───────────────────────────────────────────────────────
    local_storage_path: str = "/data"

    # ── Embeddings ──────────────────────────────────────────────────────────
    # local: all-MiniLM-L6-v2 → 384 dims
    # vertexai: text-multilingual-embedding-002 → 768 dims
    embedding_model_local: str = "all-MiniLM-L6-v2"
    embedding_model_vertexai: str = "text-multilingual-embedding-002"
    embedding_dimensions: int = 384   # 384 for local, 768 for vertexai

    # ── GCP / Vertex AI (production only) ───────────────────────────────────
    vertex_ai_project: str = ""
    vertex_ai_location: str = "us-central1"
    gcs_bucket_name: str = ""

    # ── LLM (Gemini via Vertex AI) ───────────────────────────────────────────
    gemini_model: str = "gemini-3.5-flash"

    # ── RAG tuning ──────────────────────────────────────────────────────────
    max_chunks_retrieved: int = 4
    max_session_history: int = 6
    chunk_size: int = 500
    chunk_overlap: int = 50

    # ── Rate limiting ────────────────────────────────────────────────────────
    rate_limit_enabled: bool = True

    @model_validator(mode="after")
    def _check_insecure_secret(self) -> "Settings":
        if (
            self.gcs_bucket_name  # non-empty → production deployment
            and self.local_jwt_secret in _INSECURE_SECRETS
        ):
            raise ValueError(
                "LOCAL_JWT_SECRET is set to an insecure default value. "
                "Set a strong random secret via GCP Secret Manager before deploying."
            )
        return self

    class Config:
        env_file = ".env"


@lru_cache
def get_settings() -> Settings:
    return Settings()
