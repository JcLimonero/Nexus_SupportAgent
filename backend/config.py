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
    # ── Environment ─────────────────────────────────────────────────────────
    # dev | production. Drives docs exposure, CORS mode, and the insecure-secret
    # guard. Set ENVIRONMENT=production in prod (docker-compose.prod.yml). The
    # old heuristic inferred prod from gcs_bucket_name, which is empty on the
    # on-prem VPS (local storage) — so prod silently ran as dev. is_production
    # still treats a set GCS bucket as prod for backward compatibility.
    environment: str = "dev"

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
    # https://app-nexusqtech.com:8443. Unset in production means no cross-origin
    # browser access — same-origin deployments behind nginx/IIS don't need CORS.
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
    # Number of trusted reverse proxies that prepend to X-Forwarded-For, so the
    # limiter keys on the real client IP instead of the proxy's. On-prem chain is
    # IIS(ARR) → nginx → backend, so set 2 in prod. 0 = no proxy (local dev),
    # use the direct peer IP. Assumes ARR forwards the client IP in XFF.
    trusted_proxy_hops: int = 0

    # ── Escalation abuse guards ──────────────────────────────────────────────
    # Reject new attachment uploads when free disk drops below this (MB).
    min_free_disk_mb: int = 500
    # Startup sweep: delete attachment files of resolved requests older than this.
    attachment_retention_days: int = 90

    # ── EmailJS (human-escalation notifications) ─────────────────────────────
    # Server-side REST send. All empty → email disabled (the escalation still
    # lands in the admin panel, which is the source of truth). In EmailJS, enable
    # "Allow EmailJS API for non-browser applications" and use the private key.
    emailjs_service_id: str = ""
    emailjs_template_id: str = ""
    emailjs_public_key: str = ""
    emailjs_private_key: str = ""       # accessToken for strict/server-side mode
    escalation_notify_email: str = ""   # passed to the template as {{to_email}}
    # Cap for the base64 chat PDF attached to the email. EmailJS limits
    # attachments by plan (Personal 500 Kb, Professional 2 Mb); past this the
    # email goes without the PDF instead of being rejected whole.
    emailjs_max_attach_kb: int = 350
    # Public origin, used to build the conversation links inside the email.
    public_origin: str = ""

    @property
    def is_production(self) -> bool:
        # Explicit ENVIRONMENT wins; a set GCS bucket still counts as prod so
        # existing cloud deploys keep failing loudly on a weak secret.
        return self.environment.strip().lower() == "production" or bool(self.gcs_bucket_name)

    @model_validator(mode="after")
    def _check_insecure_secret(self) -> "Settings":
        if self.is_production and self.local_jwt_secret in _INSECURE_SECRETS:
            raise ValueError(
                "LOCAL_JWT_SECRET is set to an insecure default value. "
                "Set a strong random secret in the environment before deploying."
            )
        return self

    @model_validator(mode="after")
    def _check_embedding_dims(self) -> "Settings":
        # The pgvector column width is fixed at Vector(embedding_dimensions), so
        # a provider/dimension mismatch fails every insert and query at runtime
        # instead of at startup. Catch it loudly here. local MiniLM = 384-D,
        # Vertex text-multilingual-embedding-002 = 768-D.
        expected = 768 if self.embedding_provider == "vertexai" else 384
        if self.embedding_dimensions != expected:
            raise ValueError(
                f"EMBEDDING_DIMENSIONS={self.embedding_dimensions} does not match "
                f"EMBEDDING_PROVIDER={self.embedding_provider} (expected {expected})."
            )
        return self

    class Config:
        env_file = ".env"


@lru_cache
def get_settings() -> Settings:
    return Settings()
