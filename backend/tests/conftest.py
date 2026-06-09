import pytest
import pytest_asyncio
from httpx import AsyncClient, ASGITransport
from unittest.mock import AsyncMock, MagicMock, patch

# Patch heavy dependencies before importing the app
import sys
sys.modules.setdefault("sentence_transformers", MagicMock())
sys.modules.setdefault("faster_whisper", MagicMock())
sys.modules.setdefault("fitz", MagicMock())
sys.modules.setdefault("google.auth", MagicMock())
sys.modules.setdefault("google.auth.transport", MagicMock())
sys.modules.setdefault("google.auth.transport.requests", MagicMock())
sys.modules.setdefault("httpx", __import__("httpx"))  # keep real httpx


@pytest.fixture(scope="session")
def anyio_backend():
    return "asyncio"


@pytest_asyncio.fixture
async def client():
    """Test client with an in-memory SQLite database."""
    with patch("db.connection.engine"), \
         patch("db.connection.AsyncSessionLocal"), \
         patch("db.connection.init_db", new_callable=AsyncMock):
        from main import app
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as ac:
            yield ac


@pytest_asyncio.fixture
async def auth_token(client):
    """JWT token from local auth."""
    response = await client.post(
        "/api/auth/login",
        json={"email": "test@nexus.local", "password": "any"},
    )
    return response.json()["access_token"]
