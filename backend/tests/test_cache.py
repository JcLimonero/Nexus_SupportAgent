"""Tests for semantic response cache — security + behavior."""
import json
import uuid
import datetime
import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from tests.conftest import make_jwt, make_db_override


# ── Helpers ───────────────────────────────────────────────────────────────────

def _admin_token():
    return make_jwt(is_admin=True)


def _user_token():
    return make_jwt(is_admin=False)


def _cache_stats_db(total=3, hits=10):
    async def _override():
        session = AsyncMock()
        row = MagicMock()
        row.total_entries = total
        row.total_hits = hits
        row.newest_entry = datetime.datetime(2026, 6, 1, 12, 0, 0)
        result = MagicMock()
        result.first.return_value = row
        session.execute = AsyncMock(return_value=result)
        session.commit = AsyncMock()
        yield session
    return _override


def _flush_db():
    async def _override():
        session = AsyncMock()
        session.execute = AsyncMock()
        session.commit = AsyncMock()
        yield session
    return _override


# ── Security: cache stats ─────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_cache_stats_requires_auth(client):
    response = await client.get("/api/admin/cache/stats")
    assert response.status_code == 403


@pytest.mark.anyio
async def test_cache_stats_requires_admin(client):
    response = await client.get(
        "/api/admin/cache/stats",
        headers={"Authorization": f"Bearer {_user_token()}"},
    )
    assert response.status_code == 403


@pytest.mark.anyio
async def test_cache_stats_admin_ok(client):
    from db.connection import get_db
    from main import app

    app.dependency_overrides[get_db] = _cache_stats_db(total=3, hits=10)
    response = await client.get(
        "/api/admin/cache/stats",
        headers={"Authorization": f"Bearer {_admin_token()}"},
    )
    app.dependency_overrides.clear()
    assert response.status_code == 200
    data = response.json()
    assert data["total_entries"] == 3
    assert data["total_hits"] == 10
    assert data["newest_entry"] is not None


@pytest.mark.anyio
async def test_cache_stats_empty(client):
    from db.connection import get_db
    from main import app

    app.dependency_overrides[get_db] = _cache_stats_db(total=0, hits=0)
    response = await client.get(
        "/api/admin/cache/stats",
        headers={"Authorization": f"Bearer {_admin_token()}"},
    )
    app.dependency_overrides.clear()
    assert response.status_code == 200
    assert response.json()["total_entries"] == 0
    assert response.json()["total_hits"] == 0


# ── Security: cache flush ──────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_cache_flush_requires_auth(client):
    response = await client.delete("/api/admin/cache")
    assert response.status_code == 403


@pytest.mark.anyio
async def test_cache_flush_requires_admin(client):
    response = await client.delete(
        "/api/admin/cache",
        headers={"Authorization": f"Bearer {_user_token()}"},
    )
    assert response.status_code == 403


@pytest.mark.anyio
async def test_cache_flush_admin_ok(client):
    from db.connection import get_db
    from main import app

    app.dependency_overrides[get_db] = _flush_db()
    response = await client.delete(
        "/api/admin/cache",
        headers={"Authorization": f"Bearer {_admin_token()}"},
    )
    app.dependency_overrides.clear()
    assert response.status_code == 204


# ── Unit: _lookup_cache ────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_lookup_cache_hit():
    """_lookup_cache returns entry when cosine distance ≤ threshold."""
    from routers.chat import _lookup_cache
    from db.models import ResponseCache

    entry = MagicMock(spec=ResponseCache)
    entry.answer = "Respuesta cacheada"

    mock_result = MagicMock()
    mock_result.first.return_value = (entry, 0.02)

    session = AsyncMock()
    session.execute = AsyncMock(return_value=mock_result)

    result = await _lookup_cache(session, [0.1] * 384)
    assert result is entry


@pytest.mark.anyio
async def test_lookup_cache_miss():
    """_lookup_cache returns None when no similar entry found."""
    from routers.chat import _lookup_cache

    mock_result = MagicMock()
    mock_result.first.return_value = None

    session = AsyncMock()
    session.execute = AsyncMock(return_value=mock_result)

    result = await _lookup_cache(session, [0.1] * 384)
    assert result is None


# ── Behaviour: cache hit stream response ──────────────────────────────────────

def _make_cache_hit_db(cached_entry):
    """DB that returns empty history then a cache hit."""
    async def _override():
        session = AsyncMock()
        session.commit = AsyncMock()
        session.flush = AsyncMock()

        # History result: empty list
        history_result = MagicMock()
        history_result.scalars.return_value.all.return_value = []

        # Cache lookup result: hit
        cache_result = MagicMock()
        cache_result.first.return_value = (cached_entry, 0.02)

        call_count = 0

        async def _execute(_query):
            nonlocal call_count
            call_count += 1
            # call 1 = history SELECT ChatMessage
            # call 2 = cache SELECT ResponseCache
            if call_count == 1:
                return history_result
            return cache_result

        session.execute = _execute
        yield session
    return _override


@pytest.mark.anyio
async def test_cache_hit_returns_cached_answer(client):
    from db.connection import get_db
    from main import app

    cached = MagicMock()
    cached.answer = "Respuesta cacheada"
    cached.sources = {"pdfs": [], "videos": []}
    cached.follow_ups = ["¿Cómo configuro X?"]
    cached.hit_count = 5
    cached.last_used_at = datetime.datetime.utcnow()

    # Mock the AsyncSessionLocal context manager used inside generate_cached()
    save_db = AsyncMock()
    save_db.commit = AsyncMock()
    ctx_manager = MagicMock()
    ctx_manager.__aenter__ = AsyncMock(return_value=save_db)
    ctx_manager.__aexit__ = AsyncMock(return_value=False)

    app.dependency_overrides[get_db] = _make_cache_hit_db(cached)

    # Patch names as bound in routers.chat (imported at module top)
    with patch("routers.chat.embed_text", return_value=[0.1] * 384), \
         patch("routers.chat.AsyncSessionLocal", return_value=ctx_manager):
        response = await client.post(
            "/api/chat/stream",
            json={"message": "hola", "session_id": None},
            headers={"Authorization": f"Bearer {_user_token()}"},
        )

    app.dependency_overrides.clear()

    assert response.status_code == 200
    events = [
        json.loads(line[6:])
        for line in response.text.split("\n")
        if line.startswith("data: ")
    ]
    token_events = [e for e in events if "token" in e]
    done_events = [e for e in events if e.get("done")]

    assert any(e["token"] == "Respuesta cacheada" for e in token_events)
    assert len(done_events) == 1
    assert done_events[0]["answer"] == "Respuesta cacheada"
    assert done_events[0].get("from_cache") is True
