import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from tests.conftest import make_db_override, make_jwt


def _sessions_db():
    async def _override():
        session = AsyncMock()
        result = MagicMock()
        result.scalars.return_value.all.return_value = []
        session.execute = AsyncMock(return_value=result)
        yield session
    return _override


@pytest.mark.anyio
async def test_chat_requires_auth(client):
    response = await client.post("/api/chat", json={"message": "hola"})
    assert response.status_code == 403  # HTTPBearer returns 403 when no token


@pytest.mark.anyio
async def test_chat_validates_empty_message(client):
    from db.connection import get_db
    from main import app
    token = make_jwt()
    app.dependency_overrides[get_db] = make_db_override()
    response = await client.post(
        "/api/chat",
        json={"message": ""},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 422


@pytest.mark.anyio
async def test_chat_returns_answer_structure(client):
    from db.connection import get_db
    from main import app
    token = make_jwt()
    app.dependency_overrides[get_db] = make_db_override()
    gemini_mock = {"answer": "Respuesta de prueba", "follow_ups": ["¿Cómo configuro X?", "¿Qué es Y?"]}
    with patch("routers.chat.search_chunks", new_callable=AsyncMock, return_value=[]), \
         patch("routers.chat.build_context", return_value=("sin contexto", [], [])), \
         patch("routers.chat.asyncio.to_thread", new_callable=AsyncMock, return_value=gemini_mock):
        response = await client.post(
            "/api/chat",
            json={"message": "Que es TotalDealer?"},
            headers={"Authorization": f"Bearer {token}"},
        )
    assert response.status_code == 200
    data = response.json()
    assert "answer" in data
    assert "session_id" in data
    assert "pdf_sources" in data
    assert "video_sources" in data
    assert "follow_ups" in data
    assert isinstance(data["pdf_sources"], list)
    assert isinstance(data["video_sources"], list)
    assert isinstance(data["follow_ups"], list)


@pytest.mark.anyio
async def test_sessions_list(client):
    from db.connection import get_db
    from main import app
    token = make_jwt()
    app.dependency_overrides[get_db] = _sessions_db()
    response = await client.get(
        "/api/sessions",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 200
    assert isinstance(response.json(), list)
