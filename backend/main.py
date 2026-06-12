import time
from collections import defaultdict
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import select
from starlette.middleware.base import BaseHTTPMiddleware

from config import get_settings
from db.connection import init_db, AsyncSessionLocal
from routers import health, chat, admin

settings = get_settings()


# ── In-memory rate limiter ────────────────────────────────────────────────────
# NOTE: this resets on container restart; use Redis-backed storage for
# multi-instance production deployments.

_RATE_RULES: dict[str, tuple[int, int]] = {
    "/api/auth/login":   (20, 60),   # 20 req / 60 s per IP (brute-force guard)
    "/api/chat/stream":  (60, 60),   # 60 req / 60 s per IP (LLM cost guard)
    "/api/chat":         (60, 60),
    "/api/admin/upload": (10, 60),   # 10 uploads / 60 s per IP
}


class _RateLimitMiddleware(BaseHTTPMiddleware):
    def __init__(self, app):
        super().__init__(app)
        self._windows: dict[str, list[float]] = defaultdict(list)

    async def dispatch(self, request: Request, call_next):
        if not settings.rate_limit_enabled:
            return await call_next(request)
        path = request.url.path
        for prefix, (max_req, window) in _RATE_RULES.items():
            if path == prefix or path.startswith(prefix + "/"):
                ip = (request.client.host if request.client else "unknown")
                key = f"{ip}:{prefix}"
                now = time.monotonic()
                self._windows[key] = [t for t in self._windows[key] if now - t < window]
                if len(self._windows[key]) >= max_req:
                    return JSONResponse(
                        {"detail": "Demasiadas solicitudes. Intenta más tarde."},
                        status_code=429,
                        headers={"Retry-After": str(window)},
                    )
                self._windows[key].append(now)
                break
        return await call_next(request)


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
        await db.commit()


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    await _migrate()
    if settings.auth_provider == "local":
        await _seed_admin()
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

# CORS — explicit origin list; never wildcard with credentials
_allowed_origins = (
    settings.gcs_bucket_name
    and ["https://*.run.app"]   # replaced at deploy time by frontend URL env
    or ["http://localhost:3000", "http://127.0.0.1:3000"]
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)

app.include_router(health.router)
app.include_router(chat.router)
app.include_router(admin.router)

if settings.auth_provider == "local":
    from auth.local_auth import router as local_auth_router
    from routers.users import router as users_router
    app.include_router(local_auth_router)
    app.include_router(users_router)
