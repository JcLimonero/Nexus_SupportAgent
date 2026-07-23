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

    # ── Anonymous (guest) access ─────────────────────────────────────────────
    # When True, /api/auth/guest mints short-lived tokens so people without an
    # account (e.g. clients) can use the chat. Set False to require login.
    allow_anonymous: bool = True
    guest_jwt_expire_hours: int = 6  # guests get a tighter window than registered users

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

    # ── CORS (production) ────────────────────────────────────────────────────
    # Exact frontend origin allowed to call the API, e.g.
    # https://nexus-frontend-xxxx.us-central1.run.app. When unset in production
    # we fall back to a regex that matches any *.run.app origin.
    frontend_url: str = ""

    # ── LLM (Gemini via Vertex AI) ───────────────────────────────────────────
    gemini_model: str = "gemini-3.5-flash"
    # Thinking budget (tokens). gemini-3.5-flash is a reasoning model whose
    # default dynamic budget burns several seconds of server-side thinking
    # before the first token — wasteful for extractive RAG QA. Measured on the
    # live Vertex global endpoint: budget=0 → ~1.3s TTFT (tight variance);
    # default and budget=512 → ~4–6s with high variance (512 buys no win).
    # budget=0 grounds identically to non-zero budgets on well-formed queries
    # (grounding failures observed were retrieval misses, not thinking-related).
    gemini_thinking_budget: int = 0

    # ── RAG tuning ──────────────────────────────────────────────────────────
    max_chunks_retrieved: int = 4
    max_session_history: int = 6
    chunk_size: int = 500
    chunk_overlap: int = 50
    # Media transcripts get finer chunks than documents: 500 words of speech is
    # ~3 minutes, which made jump-to-moment timestamps useless mid-video (most
    # answers matched chunk 0 → "0:00"). 150 words ≈ 1 minute of speech, so the
    # cited start_time lands within a minute of the answer.
    media_chunk_size: int = 150
    media_chunk_overlap: int = 25
    # ponytail: 0.8 is an untuned guess, not a measured threshold. It only drops
    # clearly off-topic chunks, so borderline-irrelevant context still reaches
    # the LLM. Tune against real user queries — and note local MiniLM and Vertex
    # embeddings have different distance ranges, so the value is per-provider.
    retrieval_max_distance: float = 0.8

    # ── Rate limiting ────────────────────────────────────────────────────────
    rate_limit_enabled: bool = True

    # ── SMTP (human-escalation notifications) ────────────────────────────────
    # All empty by default → email disabled (the escalation still lands in the
    # admin panel, which is the source of truth). Fill these to notify support.
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_user: str = ""
    smtp_password: str = ""
    smtp_from: str = ""                 # From address; falls back to smtp_user
    escalation_notify_email: str = ""   # where "talk to a human" requests are sent
    # Public origin, used to build the "open conversation" link inside the email.
    public_origin: str = ""

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
