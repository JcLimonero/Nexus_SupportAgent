import sys
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import jwt as PyJWT
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

# Patch heavy deps before any app imports
sys.modules.setdefault("sentence_transformers", MagicMock())
sys.modules.setdefault("faster_whisper", MagicMock())
sys.modules.setdefault("fitz", MagicMock())
sys.modules.setdefault("google", MagicMock())
sys.modules.setdefault("google.auth", MagicMock())
sys.modules.setdefault("google.auth.transport", MagicMock())
sys.modules.setdefault("google.auth.transport.requests", MagicMock())
sys.modules.setdefault("httpx", __import__("httpx"))

# Pre-import db.connection so patch("db.connection.*") resolves correctly in CI.
# Creating the engine object is safe — no actual DB connection is made until queries run.
import db.connection  # noqa: E402

def _jwt_secret() -> str:
    from config import get_settings
    return get_settings().local_jwt_secret


def make_jwt(email="test@nexus.local", is_admin=False, uid="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"):
    payload = {
        "uid": uid,
        "email": email,
        "is_admin": is_admin,
        "exp": datetime.now(timezone.utc) + timedelta(hours=1),
    }
    return PyJWT.encode(payload, _jwt_secret(), algorithm="HS256")


def make_db_override(user=None):
    """Return a get_db override that yields a mock session with scalar_one_or_none → user."""
    async def _override():
        session = AsyncMock()
        result = MagicMock()
        result.scalar_one_or_none.return_value = user
        result.first.return_value = None  # cache lookup → miss by default
        result.scalars.return_value.first.return_value = user
        result.scalars.return_value.all.return_value = [user] if user else []
        session.execute = AsyncMock(return_value=result)
        session.commit = AsyncMock()
        session.add = MagicMock()
        session.delete = AsyncMock()
        session.refresh = AsyncMock()
        yield session
    return _override


@pytest.fixture(scope="session")
def anyio_backend():
    return "asyncio"


@pytest_asyncio.fixture
async def client():
    """ASGI test client with DB patched out."""
    with patch("db.connection.engine"), \
         patch("db.connection.AsyncSessionLocal"), \
         patch("db.connection.init_db", new_callable=AsyncMock):
        from db.connection import get_db
        from main import app
        app.dependency_overrides[get_db] = make_db_override()
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
            yield ac
        app.dependency_overrides.clear()


@pytest.fixture
def auth_token():
    """JWT for a regular (non-admin) user — generated directly, no login needed."""
    return make_jwt(is_admin=False)
