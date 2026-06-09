from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import select

from config import get_settings
from db.connection import init_db, AsyncSessionLocal
from routers import health, chat, admin

settings = get_settings()


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


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    if settings.auth_provider == "local":
        await _seed_admin()
    yield


app = FastAPI(title="Nexus Support Agent", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health.router)
app.include_router(chat.router)
app.include_router(admin.router)

if settings.auth_provider == "local":
    from auth.local_auth import router as local_auth_router
    from routers.users import router as users_router
    app.include_router(local_auth_router)
    app.include_router(users_router)
