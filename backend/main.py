import time
from collections import defaultdict
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import select

from config import get_settings
from db.connection import init_db, AsyncSessionLocal
from routers import health, chat, admin, media, escalations

settings = get_settings()


# ── In-memory rate limiter ────────────────────────────────────────────────────
# ponytail: per-process counters — they reset on container restart and each
# replica limits independently, so N replicas allow N× the configured rate.
# Fine for the single-container on-prem deployment; move to Redis-backed
# storage if the backend is ever scaled out.
# Pure ASGI (not BaseHTTPMiddleware) so streaming responses pass through
# without buffering and CORS headers are still added by the outer middleware.

_RATE_RULES: dict[str, tuple[int, int]] = {
    "/api/auth/login":   (20, 60),   # 20 req / 60 s per IP (brute-force guard)
    "/api/auth/guest":   (30, 60),   # 30 guest tokens / 60 s per IP (mint-abuse guard)
    "/api/chat/stream":  (60, 60),   # 60 req / 60 s per IP (LLM cost guard)
    "/api/shared":       (120, 60),  # public share view (unguessable token; light guard)
    "/api/chat":         (60, 60),
    "/api/escalations/attachments": (20, 60),  # file uploads for a handoff request
    "/api/escalations":  (5, 60),    # 5 human-handoff requests / 60 s per IP (spam guard)
    "/api/admin/upload": (60, 60),   # 60 uploads / 60 s per IP (admin-only; bulk KB seeding)
    "/api/media/stream": (240, 60),  # HMAC-signed streaming; seeking issues many Range requests
}


def _client_ip(scope) -> str:
    """Real client IP for rate limiting. Behind the reverse-proxy chain the
    direct peer is the proxy, so its X-Forwarded-For carries the client; with
    `trusted_proxy_hops` proxies prepending to it, the client sits `hops` from
    the right (spoof-proof — a client-supplied XFF lands further left). hops=0
    (local dev) uses the direct peer."""
    hops = settings.trusted_proxy_hops
    if hops > 0:
        for k, v in scope.get("headers", []):
            if k == b"x-forwarded-for":
                parts = [p.strip().decode("latin-1") for p in v.split(b",") if p.strip()]
                if parts:
                    return parts[-hops] if len(parts) >= hops else parts[0]
                break
    client = scope.get("client")
    return client[0] if client else "unknown"


class _RateLimitMiddleware:
    def __init__(self, app):
        self.app = app
        self._windows: dict[str, list[float]] = defaultdict(list)
        self._hits = 0  # sweep counter for pruning stale IP keys

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not settings.rate_limit_enabled:
            await self.app(scope, receive, send)
            return
        path = scope.get("path", "")
        for prefix, (max_req, window) in _RATE_RULES.items():
            if path == prefix or path.startswith(prefix + "/"):
                ip = _client_ip(scope)
                key = f"{ip}:{prefix}"
                now = time.monotonic()
                self._windows[key] = [t for t in self._windows[key] if now - t < window]
                if len(self._windows[key]) >= max_req:
                    response = JSONResponse(
                        {"detail": "Demasiadas solicitudes. Intenta más tarde."},
                        status_code=429,
                        headers={"Retry-After": str(window)},
                    )
                    await response(scope, receive, send)
                    return
                self._windows[key].append(now)
                # Prune keys for IPs that stopped sending — otherwise the dict
                # grows one entry per IP ever seen, forever.
                self._hits += 1
                if self._hits % 1000 == 0:
                    max_window = max(w for _, w in _RATE_RULES.values())
                    stale = [
                        k for k, ts in self._windows.items()
                        if not ts or now - ts[-1] >= max_window
                    ]
                    for k in stale:
                        del self._windows[k]
                break
        await self.app(scope, receive, send)


# ── App lifecycle ─────────────────────────────────────────────────────────────

async def _seed_admin():
    """Create the initial admin user if no users exist."""
    from auth.local_auth import hash_password
    from db.models import User

    async with AsyncSessionLocal() as db:
        result = await db.execute(select(User))
        if result.scalars().first() is not None:
            return
        db.add(User(
            email=settings.initial_admin_email,
            hashed_password=hash_password(settings.initial_admin_password),
            is_admin=True,
        ))
        await db.commit()


async def _migrate():
    """Add columns introduced after initial schema creation."""
    from sqlalchemy import text
    async with AsyncSessionLocal() as db:
        await db.execute(text(
            "ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS title TEXT"
        ))
        await db.execute(text(
            "ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS user_label TEXT"
        ))
        await db.execute(text(
            "ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS is_anonymous BOOLEAN NOT NULL DEFAULT FALSE"
        ))
        await db.execute(text(
            "ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS share_token TEXT"
        ))
        await db.execute(text(
            "CREATE UNIQUE INDEX IF NOT EXISTS ix_chat_sessions_share_token "
            "ON chat_sessions (share_token)"
        ))
        await db.execute(text(
            "ALTER TABLE escalation_requests ADD COLUMN IF NOT EXISTS "
            "attachments JSONB NOT NULL DEFAULT '[]'::jsonb"
        ))
        await db.commit()


async def _evict_stale_cache():
    """Drop semantic-cache entries unused for 30 days — the table otherwise
    only shrinks on manual/full flush. Startup-time is enough at this scale."""
    from datetime import datetime, timedelta
    from sqlalchemy import delete
    from db.models import ResponseCache

    async with AsyncSessionLocal() as db:
        await db.execute(delete(ResponseCache).where(
            ResponseCache.last_used_at < datetime.utcnow() - timedelta(days=30)
        ))
        await db.commit()


@asynccontextmanager
async def lifespan(app: FastAPI):
    import asyncio
    from retrieval.vector_search import warm_up

    from routers.escalations import evict_old_attachments

    await init_db()
    await _migrate()
    await _seed_admin()
    await _evict_stale_cache()
    await evict_old_attachments()
    # Preload the embedding model so the first user doesn't pay the ~6s
    # cold-load. Run in a thread to avoid blocking the event loop.
    await asyncio.to_thread(warm_up)
    yield


# ── FastAPI app ───────────────────────────────────────────────────────────────

_is_prod = bool(settings.gcs_bucket_name)  # GCS bucket set → production

app = FastAPI(
    title="Nexus Support Agent",
    version="1.0.0",
    lifespan=lifespan,
    # Disable interactive docs in production to reduce attack surface
    docs_url="/docs" if not _is_prod else None,
    redoc_url="/redoc" if not _is_prod else None,
    openapi_url="/openapi.json" if not _is_prod else None,
)

# Rate limiting before any auth processing
app.add_middleware(_RateLimitMiddleware)

# CORS — never wildcard with credentials. In production only the exact
# FRONTEND_URL origin is allowed; unset means no cross-origin browser access
# (same-origin deployments behind nginx/IIS don't need CORS at all). The old
# *.run.app regex fallback let ANY Cloud Run app call the API from a victim's
# browser — set FRONTEND_URL explicitly on split-origin deployments.
_cors_kwargs: dict = {}
if _is_prod:
    _cors_kwargs["allow_origins"] = [settings.frontend_url] if settings.frontend_url else []
else:
    _cors_kwargs["allow_origins"] = ["http://localhost:3000", "http://127.0.0.1:3000"]

app.add_middleware(
    CORSMiddleware,
    **_cors_kwargs,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)

app.include_router(health.router)
app.include_router(chat.router)
app.include_router(admin.router)
app.include_router(media.router)
app.include_router(escalations.router)

from auth.local_auth import router as local_auth_router
from routers.users import router as users_router
app.include_router(local_auth_router)
app.include_router(users_router)
