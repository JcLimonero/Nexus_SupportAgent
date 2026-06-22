import time
from collections import defaultdict
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import select

from config import get_settings
from db.connection import init_db, AsyncSessionLocal
from routers import health, chat, admin

settings = get_settings()


# ── In-memory rate limiter ────────────────────────────────────────────────────
# NOTE: this resets on container restart; use Redis-backed storage for
# multi-instance production deployments.
# Pure ASGI (not BaseHTTPMiddleware) so streaming responses pass through
# without buffering and CORS headers are still added by the outer middleware.

_RATE_RULES: dict[str, tuple[int, int]] = {
    "/api/auth/login":   (20, 60),   # 20 req / 60 s per IP (brute-force guard)
    "/api/auth/guest":   (30, 60),   # 30 guest tokens / 60 s per IP (mint-abuse guard)
    "/api/chat/stream":  (60, 60),   # 60 req / 60 s per IP (LLM cost guard)
    "/api/shared":       (120, 60),  # public share view (unguessable token; light guard)
    "/api/chat":         (60, 60),
    "/api/admin/upload": (60, 60),   # 60 uploads / 60 s per IP (admin-only; bulk KB seeding)
}


class _RateLimitMiddleware:
    def __init__(self, app):
        self.app = app
        self._windows: dict[str, list[float]] = defaultdict(list)

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not settings.rate_limit_enabled:
            await self.app(scope, receive, send)
            return
        path = scope.get("path", "")
        for prefix, (max_req, window) in _RATE_RULES.items():
            if path == prefix or path.startswith(prefix + "/"):
                client = scope.get("client")
                ip = client[0] if client else "unknown"
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
        await db.commit()


@asynccontextmanager
async def lifespan(app: FastAPI):
    import asyncio
    from retrieval.vector_search import warm_up

    await init_db()
    await _migrate()
    await _seed_admin()
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

# CORS — never wildcard with credentials. In production we allow the exact
# frontend origin when FRONTEND_URL is set, and otherwise fall back to a regex
# matching any Cloud Run (*.run.app) host (a literal "https://*.run.app" string
# is NOT glob-matched by Starlette and would block every request).
_cors_kwargs: dict = {}
if _is_prod:
    _cors_kwargs["allow_origins"] = [settings.frontend_url] if settings.frontend_url else []
    if not settings.frontend_url:
        _cors_kwargs["allow_origin_regex"] = r"https://[a-z0-9.-]+\.run\.app"
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

from auth.local_auth import router as local_auth_router
from routers.users import router as users_router
app.include_router(local_auth_router)
app.include_router(users_router)
