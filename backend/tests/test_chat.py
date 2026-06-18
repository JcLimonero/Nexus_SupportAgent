import json
import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from tests.conftest import make_db_override, make_jwt


# ── Streaming helpers ─────────────────────────────────────────────────────────

def _make_save_db_mock():
    """Return a mock async context manager for AsyncSessionLocal used in generate()."""
    save_db = AsyncMock()
    save_db.add = MagicMock()
    save_db.commit = AsyncMock()
    cm = MagicMock()
    cm.__aenter__ = AsyncMock(return_value=save_db)
    cm.__aexit__ = AsyncMock(return_value=False)
    return MagicMock(return_value=cm)


def _parse_sse(text: str) -> list[dict]:
    events = []
    for chunk in text.split("\n\n"):
        chunk = chunk.strip()
        if chunk.startswith("data: "):
            try:
                events.append(json.loads(chunk[6:]))
            except json.JSONDecodeError:
                pass
    return events


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
    assert response.status_code == 401  # HTTPBearer returns 401 when no token


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
    assert response.status_code == 401


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
    assert response.status_code == 401


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


# ── SSE streaming tests ───────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_chat_stream_requires_auth(client):
    response = await client.post("/api/chat/stream", json={"message": "hola"})
    assert response.status_code == 401


@pytest.mark.anyio
async def test_chat_stream_validates_empty_message(client):
    from db.connection import get_db
    from main import app
    token = make_jwt()
    app.dependency_overrides[get_db] = make_db_override()
    response = await client.post(
        "/api/chat/stream",
        json={"message": ""},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 422


@pytest.mark.anyio
async def test_chat_stream_tokens_and_done_event(client):
    """SSE stream emits token events, strips NEXUS_FOLLOW_UPS, and sends a done event."""
    from db.connection import get_db
    from main import app
    token = make_jwt()
    app.dependency_overrides[get_db] = make_db_override()

    async def _mock_stream(*_args, **_kwargs):
        yield "Esta es "
        yield "una respuesta de prueba."
        yield "\nNEXUS_FOLLOW_UPS: [\"¿Cómo configuro X?\", \"¿Qué es Y?\"]"

    with patch("routers.chat.search_chunks", new_callable=AsyncMock, return_value=[]), \
         patch("routers.chat.build_context", return_value=("", [], [])), \
         patch("routers.chat.stream_gemini_response", side_effect=_mock_stream), \
         patch("routers.chat.AsyncSessionLocal", _make_save_db_mock()):
        response = await client.post(
            "/api/chat/stream",
            json={"message": "como configuro el inventario"},
            headers={"Authorization": f"Bearer {token}"},
        )

    assert response.status_code == 200
    assert "text/event-stream" in response.headers.get("content-type", "")

    events = _parse_sse(response.text)
    token_events = [e for e in events if "token" in e]
    done_events  = [e for e in events if e.get("done")]

    assert len(token_events) >= 1, "expected at least one token chunk"
    assert not any("NEXUS_FOLLOW_UPS" in e["token"] for e in token_events), \
        "marker must not reach the client"

    assert len(done_events) == 1
    done = done_events[0]
    assert "session_id" in done
    assert "answer" in done
    assert "NEXUS_FOLLOW_UPS" not in done["answer"]
    assert done["follow_ups"] == ["¿Cómo configuro X?", "¿Qué es Y?"]
    assert isinstance(done["pdf_sources"], list)
    assert isinstance(done["video_sources"], list)


@pytest.mark.anyio
async def test_chat_stream_strips_long_followup_marker_split_across_chunks(client):
    """Regression: long follow-up arrays (>150 chars) streamed token-by-token
    must still be fully stripped — the marker line is longer than any fixed tail
    buffer, so a char-by-char stream must not leak any of it to the client."""
    from db.connection import get_db
    from main import app
    token = make_jwt()
    app.dependency_overrides[get_db] = make_db_override()

    answer = "Aquí tienes los pasos detallados para completar la configuración."
    # Two long Spanish follow-ups — the marker line is ~190 chars.
    marker_line = (
        '\nNEXUS_FOLLOW_UPS: ['
        '"¿Quién es el responsable de generar y entregar las credenciales de acceso?", '
        '"¿Con qué plataformas de correo y panel de control funciona este manual?"]'
    )
    full = answer + marker_line

    async def _mock_stream(*_args, **_kwargs):
        # Stream one character at a time — the worst case for marker detection.
        for ch in full:
            yield ch

    with patch("routers.chat.search_chunks", new_callable=AsyncMock, return_value=[]), \
         patch("routers.chat.build_context", return_value=("", [], [])), \
         patch("routers.chat.stream_gemini_response", side_effect=_mock_stream), \
         patch("routers.chat.AsyncSessionLocal", _make_save_db_mock()):
        response = await client.post(
            "/api/chat/stream",
            json={"message": "como configuro las credenciales"},
            headers={"Authorization": f"Bearer {token}"},
        )

    assert response.status_code == 200
    events = _parse_sse(response.text)
    token_events = [e for e in events if "token" in e]
    done = next(e for e in events if e.get("done"))

    streamed = "".join(e["token"] for e in token_events)
    assert "NEXUS_FOLLOW_UPS" not in streamed, "marker leaked into streamed tokens"
    assert streamed.strip() == answer, "client should receive exactly the answer text"
    assert done["answer"] == answer
    assert done["follow_ups"] == [
        "¿Quién es el responsable de generar y entregar las credenciales de acceso?",
        "¿Con qué plataformas de correo y panel de control funciona este manual?",
    ]


@pytest.mark.anyio
async def test_chat_stream_answer_content_matches_tokens(client):
    """The answer in the done event equals the concatenation of all token chunks."""
    from db.connection import get_db
    from main import app
    token = make_jwt()
    app.dependency_overrides[get_db] = make_db_override()

    async def _mock_stream(*_args, **_kwargs):
        yield "Parte uno. "
        yield "Parte dos."
        yield "\nNEXUS_FOLLOW_UPS: []"

    with patch("routers.chat.search_chunks", new_callable=AsyncMock, return_value=[]), \
         patch("routers.chat.build_context", return_value=("", [], [])), \
         patch("routers.chat.stream_gemini_response", side_effect=_mock_stream), \
         patch("routers.chat.AsyncSessionLocal", _make_save_db_mock()):
        response = await client.post(
            "/api/chat/stream",
            json={"message": "hola"},
            headers={"Authorization": f"Bearer {token}"},
        )

    events = _parse_sse(response.text)
    streamed = "".join(e["token"] for e in events if "token" in e)
    done = next(e for e in events if e.get("done"))

    assert done["answer"] == streamed.rstrip()


# ── Session identity (anonymous vs registered) ────────────────────────────────

def test_guest_label_format():
    from auth.local_auth import guest_label
    assert guest_label("anon:ab12cd34ef") == "Invitado #ab12"


def test_session_identity_for_guest():
    from routers.chat import _session_identity
    is_anon, label = _session_identity({"uid": "anon:ab12cd34", "is_anon": True, "email": "Invitado #ab12"})
    assert is_anon is True
    assert label == "Invitado #ab12"


def test_session_identity_for_registered_user():
    from routers.chat import _session_identity
    is_anon, label = _session_identity({"uid": "uuid-123", "is_admin": False, "email": "ana@empresa.com"})
    assert is_anon is False
    assert label == "ana@empresa.com"


# ── No-info fallback suppresses citations ─────────────────────────────────────

def test_is_no_info_detects_fallback():
    from routers.chat import _is_no_info
    assert _is_no_info("No tengo información sobre ese tema en los documentos disponibles. "
                       "Te recomiendo contactar al equipo de soporte.")
    assert not _is_no_info("Para resolver un caso de refacciones sigue estos pasos...")


# ── Content-based suggestions (never file names) ──────────────────────────────

def _suggestions_db_override(rows):
    async def _override():
        session = AsyncMock()
        result = MagicMock()
        result.all.return_value = rows
        session.execute = AsyncMock(return_value=result)
        yield session
    return _override


@pytest.mark.anyio
async def test_suggestions_fallback_when_no_docs(client):
    from db.connection import get_db
    from main import app
    from routers.chat import clear_suggestions_cache, _FALLBACK_SUGGESTIONS
    clear_suggestions_cache()
    app.dependency_overrides[get_db] = _suggestions_db_override([])
    r = await client.get("/api/suggestions", headers={"Authorization": f"Bearer {make_jwt()}"})
    app.dependency_overrides.clear()
    clear_suggestions_cache()
    assert r.status_code == 200
    assert r.json() == _FALLBACK_SUGGESTIONS


@pytest.mark.anyio
async def test_suggestions_are_content_based_not_filenames(client):
    from db.connection import get_db
    from main import app
    from routers.chat import clear_suggestions_cache
    clear_suggestions_cache()

    row = MagicMock()
    row.file_name = "Caso_01_Refacciones.docx"
    row.source_type = "docx"
    row.content = "Departamento: Refacciones. Se recibe ticket sobre existencia de piezas..."
    app.dependency_overrides[get_db] = _suggestions_db_override([row])

    generated = [{"label": "Resolver refacciones", "prompt": "¿Cómo resuelvo un caso de refacciones?"}]
    with patch("llm.gemini_client.generate_suggestion_questions", return_value=generated):
        r = await client.get("/api/suggestions", headers={"Authorization": f"Bearer {make_jwt()}"})
    app.dependency_overrides.clear()
    clear_suggestions_cache()

    assert r.status_code == 200
    data = r.json()
    assert data == generated
    # No suggestion may leak a file name / case id / extension.
    for s in data:
        assert ".docx" not in s["prompt"] and "Caso_01" not in s["prompt"]
        assert ".docx" not in s["label"] and "Caso_01" not in s["label"]


@pytest.mark.anyio
async def test_suggestions_fallback_on_generation_error(client):
    from db.connection import get_db
    from main import app
    from routers.chat import clear_suggestions_cache, _FALLBACK_SUGGESTIONS
    clear_suggestions_cache()

    row = MagicMock()
    row.file_name = "x.pdf"; row.source_type = "pdf"; row.content = "algo"
    app.dependency_overrides[get_db] = _suggestions_db_override([row])
    with patch("llm.gemini_client.generate_suggestion_questions", side_effect=RuntimeError("boom")):
        r = await client.get("/api/suggestions", headers={"Authorization": f"Bearer {make_jwt()}"})
    app.dependency_overrides.clear()
    clear_suggestions_cache()
    assert r.status_code == 200
    assert r.json() == _FALLBACK_SUGGESTIONS
