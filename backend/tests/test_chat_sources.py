"""Citation narrowing via NEXUS_FUENTES (phase 26).

The 2026-09 production audit found 28 of 28 answers citing a full four sources,
including plainly unrelated ones. Retrieval can't fix that — these tests cover
the mechanism that does: the model declares which fragments it actually used.
"""
import json
from unittest.mock import AsyncMock, patch

import pytest

from routers.chat import _first_marker, _trailer_list, _sources_for, _NEXUS_MARKER, _SOURCES_MARKER
from tests.conftest import make_jwt, make_db_override
from tests.test_chat import _parse_sse, _make_save_db_mock


def _chunk(name, stype="pdf", page=1):
    return {
        "id": f"id-{name}-{page}", "content": f"contenido de {name}", "source_type": stype,
        "file_name": name, "gcs_url": f"/data/{stype}s/{name}", "page_number": page,
        "start_time": None,
    }


# ── Trailer parsing ─────────────────────────────────────────────────────────────

def test_first_marker_finds_earliest_of_both():
    text = "respuesta\nNEXUS_FUENTES: [1]\nNEXUS_FOLLOW_UPS: []"
    assert _first_marker(text) == text.index(_SOURCES_MARKER)


def test_first_marker_handles_reversed_order():
    """The answer must end at whichever trailer line the model emits first."""
    text = "respuesta\nNEXUS_FOLLOW_UPS: []\nNEXUS_FUENTES: [1]"
    assert _first_marker(text) == text.index(_NEXUS_MARKER)


def test_first_marker_absent():
    assert _first_marker("solo una respuesta") == -1


def test_trailer_list_reads_only_its_own_line():
    trailer = 'NEXUS_FUENTES: [1, 3]\nNEXUS_FOLLOW_UPS: ["a", "b"]'
    assert _trailer_list(trailer, _SOURCES_MARKER) == [1, 3]
    assert _trailer_list(trailer, _NEXUS_MARKER) == ["a", "b"]


def test_trailer_list_missing_marker_is_none():
    assert _trailer_list("NEXUS_FOLLOW_UPS: []", _SOURCES_MARKER) is None


def test_trailer_list_malformed_json_is_none():
    assert _trailer_list("NEXUS_FUENTES: [1, ", _SOURCES_MARKER) is None


def test_trailer_list_non_list_is_none():
    assert _trailer_list('NEXUS_FUENTES: {"a": 1}', _SOURCES_MARKER) is None


# ── Narrowing ───────────────────────────────────────────────────────────────────

def test_sources_narrowed_to_declared_fragments():
    chunks = [_chunk("a.pdf"), _chunk("b.pdf"), _chunk("c.pdf")]
    pdfs, videos = _sources_for(chunks, [1, 3])
    assert [p["file_name"] for p in pdfs] == ["a.pdf", "c.pdf"]
    assert videos == []


def test_missing_marker_falls_back_to_citing_everything():
    """An absent declaration must not silently drop every citation."""
    chunks = [_chunk("a.pdf"), _chunk("b.pdf")]
    pdfs, _ = _sources_for(chunks, None)
    assert [p["file_name"] for p in pdfs] == ["a.pdf", "b.pdf"]


def test_empty_declaration_cites_nothing():
    """Distinct from None: the model read them and none carried the answer."""
    chunks = [_chunk("a.pdf"), _chunk("b.pdf")]
    assert _sources_for(chunks, []) == ([], [])


def test_out_of_range_indices_ignored():
    chunks = [_chunk("a.pdf")]
    pdfs, _ = _sources_for(chunks, [0, 1, 2, 99, -3])
    assert [p["file_name"] for p in pdfs] == ["a.pdf"]


def test_non_integer_indices_ignored():
    chunks = [_chunk("a.pdf"), _chunk("b.pdf")]
    pdfs, _ = _sources_for(chunks, ["1", None, 2, 1.5])
    assert [p["file_name"] for p in pdfs] == ["b.pdf"]


def test_videos_separated_from_documents():
    chunks = [_chunk("v.mp4", "video", None), _chunk("d.pdf")]
    pdfs, videos = _sources_for(chunks, [1, 2])
    assert [v["file_name"] for v in videos] == ["v.mp4"]
    assert [p["file_name"] for p in pdfs] == ["d.pdf"]


# ── End to end through the SSE stream ───────────────────────────────────────────

@pytest.mark.anyio
async def test_stream_cites_only_declared_fragments(client):
    from db.connection import get_db
    from main import app
    app.dependency_overrides[get_db] = make_db_override()

    chunks = [_chunk("relevante.pdf"), _chunk("ruido_1.pdf"), _chunk("ruido_2.pdf")]

    async def _mock_stream(*_a, **_k):
        yield "Para hacerlo, ve a Caja > Anticipos."
        yield "\nNEXUS_FUENTES: [1]"
        yield '\nNEXUS_FOLLOW_UPS: ["¿Y si no aparece?"]'

    with patch("routers.chat.search_chunks", new_callable=AsyncMock, return_value=chunks), \
         patch("routers.chat.stream_gemini_response", side_effect=_mock_stream), \
         patch("routers.chat.AsyncSessionLocal", _make_save_db_mock()):
        response = await client.post(
            "/api/chat/stream",
            json={"message": "como aplico un anticipo"},
            headers={"Authorization": f"Bearer {make_jwt()}"},
        )

    assert response.status_code == 200
    events = _parse_sse(response.text)
    done = next(e for e in events if e.get("done"))

    assert [p["file_name"] for p in done["pdf_sources"]] == ["relevante.pdf"], \
        "solo debe citarse el fragmento declarado"
    assert done["follow_ups"] == ["¿Y si no aparece?"]

    streamed = "".join(e["token"] for e in events if "token" in e)
    assert "NEXUS_FUENTES" not in streamed, "el marcador no debe llegar al cliente"
    assert "NEXUS_FOLLOW_UPS" not in streamed
    assert streamed.strip() == "Para hacerlo, ve a Caja > Anticipos."
    assert "NEXUS_FUENTES" not in done["answer"]


@pytest.mark.anyio
async def test_stream_without_marker_keeps_old_behaviour(client):
    """A model that never learns the new marker must not lose its citations."""
    from db.connection import get_db
    from main import app
    app.dependency_overrides[get_db] = make_db_override()

    chunks = [_chunk("a.pdf"), _chunk("b.pdf")]

    async def _mock_stream(*_a, **_k):
        yield "Respuesta sin marcador de fuentes."
        yield '\nNEXUS_FOLLOW_UPS: []'

    with patch("routers.chat.search_chunks", new_callable=AsyncMock, return_value=chunks), \
         patch("routers.chat.stream_gemini_response", side_effect=_mock_stream), \
         patch("routers.chat.AsyncSessionLocal", _make_save_db_mock()):
        response = await client.post(
            "/api/chat/stream",
            json={"message": "pregunta"},
            headers={"Authorization": f"Bearer {make_jwt()}"},
        )

    done = next(e for e in _parse_sse(response.text) if e.get("done"))
    assert [p["file_name"] for p in done["pdf_sources"]] == ["a.pdf", "b.pdf"]


@pytest.mark.anyio
async def test_no_info_still_suppresses_sources_despite_declaration(client):
    """The no-info rule outranks the declaration — a model that says it has
    nothing must not cite documents even if it also lists fragments."""
    from db.connection import get_db
    from main import app
    app.dependency_overrides[get_db] = make_db_override()

    chunks = [_chunk("a.pdf")]

    async def _mock_stream(*_a, **_k):
        yield "No tengo información sobre ese tema en los documentos disponibles."
        yield "\nNEXUS_FUENTES: [1]"
        yield "\nNEXUS_FOLLOW_UPS: []"

    with patch("routers.chat.search_chunks", new_callable=AsyncMock, return_value=chunks), \
         patch("routers.chat.stream_gemini_response", side_effect=_mock_stream), \
         patch("routers.chat.AsyncSessionLocal", _make_save_db_mock()):
        response = await client.post(
            "/api/chat/stream",
            json={"message": "algo no cubierto"},
            headers={"Authorization": f"Bearer {make_jwt()}"},
        )

    done = next(e for e in _parse_sse(response.text) if e.get("done"))
    assert done["pdf_sources"] == []
    assert done["video_sources"] == []
