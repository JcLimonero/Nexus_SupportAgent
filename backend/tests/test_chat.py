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


@pytest.mark.anyio
async def test_new_session_title_set_from_first_message(client):
    """Title on new session equals the first user message."""
    from db.connection import get_db
    from db.models import ChatSession
    from main import app
    token = make_jwt()

    added_objects = []

    async def _capture_db():
        session = AsyncMock()
        result = MagicMock()
        result.scalar_one_or_none.return_value = None
        result.scalars.return_value.all.return_value = []
        session.execute = AsyncMock(return_value=result)
        session.commit = AsyncMock()
        session.flush = AsyncMock()
        session.add = MagicMock(side_effect=added_objects.append)
        yield session

    app.dependency_overrides[get_db] = _capture_db
    gemini_mock = {"answer": "Respuesta", "follow_ups": []}
    with patch("routers.chat.search_chunks", new_callable=AsyncMock, return_value=[]), \
         patch("routers.chat.build_context", return_value=("", [], [])), \
         patch("routers.chat.asyncio.to_thread", new_callable=AsyncMock, return_value=gemini_mock):
        response = await client.post(
            "/api/chat",
            json={"message": "como configuro el inventario"},
            headers={"Authorization": f"Bearer {token}"},
        )

    assert response.status_code == 200
    chat_session = next((o for o in added_objects if isinstance(o, ChatSession)), None)
    assert chat_session is not None
    assert chat_session.title == "como configuro el inventario"


@pytest.mark.anyio
async def test_long_message_title_truncated(client):
    """Messages longer than 60 chars are truncated with ellipsis."""
    from db.connection import get_db
    from db.models import ChatSession
    from main import app
    token = make_jwt()

    added_objects = []

    async def _capture_db():
        session = AsyncMock()
        result = MagicMock()
        result.scalar_one_or_none.return_value = None
        result.scalars.return_value.all.return_value = []
        session.execute = AsyncMock(return_value=result)
        session.commit = AsyncMock()
        session.flush = AsyncMock()
        session.add = MagicMock(side_effect=added_objects.append)
        yield session

    app.dependency_overrides[get_db] = _capture_db
    gemini_mock = {"answer": "Respuesta", "follow_ups": []}
    with patch("routers.chat.search_chunks", new_callable=AsyncMock, return_value=[]), \
         patch("routers.chat.build_context", return_value=("", [], [])), \
         patch("routers.chat.asyncio.to_thread", new_callable=AsyncMock, return_value=gemini_mock):
        response = await client.post(
            "/api/chat",
            json={"message": "a" * 80},
            headers={"Authorization": f"Bearer {token}"},
        )

    assert response.status_code == 200
    chat_session = next((o for o in added_objects if isinstance(o, ChatSession)), None)
    assert chat_session is not None
    assert len(chat_session.title) <= 60
    assert chat_session.title.endswith("...")


@pytest.mark.anyio
async def test_sessions_list_includes_title(client):
    """GET /sessions returns title field for each session."""
    import uuid
    from datetime import datetime
    from db.connection import get_db
    from db.models import ChatSession
    from main import app
    token = make_jwt()

    fake_session = MagicMock(spec=ChatSession)
    fake_session.id = uuid.uuid4()
    fake_session.title = "pregunta de prueba"
    fake_session.created_at = datetime.utcnow()

    async def _sessions_with_title():
        session = AsyncMock()
        result = MagicMock()
        result.scalars.return_value.all.return_value = [fake_session]
        session.execute = AsyncMock(return_value=result)
        yield session

    app.dependency_overrides[get_db] = _sessions_with_title
    response = await client.get("/api/sessions", headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 200
    sessions = response.json()
    assert len(sessions) == 1
    assert sessions[0]["title"] == "pregunta de prueba"


# ── CRUD tests ────────────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_rename_session(client):
    """PATCH /sessions/{id} updates the title."""
    import uuid
    from db.connection import get_db
    from db.models import ChatSession
    from main import app
    token = make_jwt()

    fake_session = MagicMock(spec=ChatSession)
    fake_session.id = uuid.uuid4()
    fake_session.title = "título original"
    fake_session.user_id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"

    async def _db():
        session = AsyncMock()
        result = MagicMock()
        result.scalar_one_or_none.return_value = fake_session
        session.execute = AsyncMock(return_value=result)
        session.commit = AsyncMock()
        yield session

    app.dependency_overrides[get_db] = _db
    sid = str(fake_session.id)
    response = await client.patch(
        f"/api/sessions/{sid}",
        json={"title": "nuevo título"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 200
    assert response.json()["title"] == "nuevo título"
    assert fake_session.title == "nuevo título"


@pytest.mark.anyio
async def test_rename_session_requires_auth(client):
    import uuid
    response = await client.patch(f"/api/sessions/{uuid.uuid4()}", json={"title": "x"})
    assert response.status_code == 403


@pytest.mark.anyio
async def test_rename_session_not_found(client):
    import uuid
    from db.connection import get_db
    from main import app
    token = make_jwt()

    async def _empty_db():
        session = AsyncMock()
        result = MagicMock()
        result.scalar_one_or_none.return_value = None
        session.execute = AsyncMock(return_value=result)
        yield session

    app.dependency_overrides[get_db] = _empty_db
    response = await client.patch(
        f"/api/sessions/{uuid.uuid4()}",
        json={"title": "x"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 404


@pytest.mark.anyio
async def test_delete_session(client):
    """DELETE /sessions/{id} removes the session."""
    import uuid
    from db.connection import get_db
    from db.models import ChatSession
    from main import app
    token = make_jwt()

    fake_session = MagicMock(spec=ChatSession)
    fake_session.id = uuid.uuid4()

    async def _db():
        session = AsyncMock()
        result = MagicMock()
        result.scalar_one_or_none.return_value = fake_session
        session.execute = AsyncMock(return_value=result)
        session.delete = AsyncMock()
        session.commit = AsyncMock()
        yield session

    app.dependency_overrides[get_db] = _db
    response = await client.delete(
        f"/api/sessions/{fake_session.id}",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 204


@pytest.mark.anyio
async def test_delete_session_requires_auth(client):
    import uuid
    response = await client.delete(f"/api/sessions/{uuid.uuid4()}")
    assert response.status_code == 403


@pytest.mark.anyio
async def test_delete_session_not_found(client):
    import uuid
    from db.connection import get_db
    from main import app
    token = make_jwt()

    async def _empty_db():
        session = AsyncMock()
        result = MagicMock()
        result.scalar_one_or_none.return_value = None
        session.execute = AsyncMock(return_value=result)
        yield session

    app.dependency_overrides[get_db] = _empty_db
    response = await client.delete(
        f"/api/sessions/{uuid.uuid4()}",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 404
