import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from tests.conftest import make_db_override, make_jwt


def _admin():
    return make_jwt(is_admin=True)


def _user():
    return make_jwt(is_admin=False)


# ── Upload ────────────────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_upload_requires_auth(client):
    response = await client.post(
        "/api/admin/upload",
        files={"file": ("test.pdf", b"content", "application/pdf")},
    )
    assert response.status_code == 401


@pytest.mark.anyio
async def test_upload_requires_admin(client):
    """Regular (non-admin) authenticated user must not upload documents."""
    from db.connection import get_db
    from main import app
    app.dependency_overrides[get_db] = make_db_override()
    response = await client.post(
        "/api/admin/upload",
        files={"file": ("test.pdf", b"%PDF-1.4 content", "application/pdf")},
        headers={"Authorization": f"Bearer {_user()}"},
    )
    app.dependency_overrides.clear()
    assert response.status_code == 403


@pytest.mark.anyio
async def test_upload_rejects_unsupported_type(client):
    from db.connection import get_db
    from main import app
    app.dependency_overrides[get_db] = make_db_override()
    response = await client.post(
        "/api/admin/upload",
        files={"file": ("test.zip", b"PK\x03\x04binary", "application/zip")},
        headers={"Authorization": f"Bearer {_admin()}"},
    )
    assert response.status_code == 400


@pytest.mark.anyio
async def test_upload_rejects_binary_disguised_as_text(client):
    """A binary file renamed to .txt (contains NUL bytes) must be rejected."""
    from db.connection import get_db
    from main import app
    app.dependency_overrides[get_db] = make_db_override()
    response = await client.post(
        "/api/admin/upload",
        files={"file": ("evil.txt", b"text\x00\x00binary", "text/plain")},
        headers={"Authorization": f"Bearer {_admin()}"},
    )
    assert response.status_code == 400


@pytest.mark.anyio
async def test_upload_rejects_wrong_magic_bytes(client):
    """A file renamed to .pdf but with executable magic bytes must be rejected."""
    from db.connection import get_db
    from main import app
    app.dependency_overrides[get_db] = make_db_override()
    # MZ header = Windows PE executable
    exe_content = b"MZ\x90\x00\x03\x00" + b"\x00" * 506
    response = await client.post(
        "/api/admin/upload",
        files={"file": ("evil.pdf", exe_content, "application/pdf")},
        headers={"Authorization": f"Bearer {_admin()}"},
    )
    assert response.status_code == 400


@pytest.mark.anyio
async def test_upload_rejects_oversized_file(client):
    from db.connection import get_db
    from main import app
    app.dependency_overrides[get_db] = make_db_override()
    big = b"%PDF-1.4 " + b"A" * (100 * 1024 * 1024 + 1)  # 100 MB + 1 byte
    response = await client.post(
        "/api/admin/upload",
        files={"file": ("big.pdf", big, "application/pdf")},
        headers={"Authorization": f"Bearer {_admin()}"},
    )
    assert response.status_code == 413


@pytest.mark.anyio
async def test_upload_pdf_accepted(client):
    from db.connection import get_db
    from main import app
    app.dependency_overrides[get_db] = make_db_override()
    # Real minimal PDF magic bytes
    pdf_magic = b"%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n"
    with patch("routers.admin.save_file", return_value="/data/pdfs/manual.pdf"), \
         patch("routers.admin.filetype.guess") as mock_guess:
        mock_guess.return_value = MagicMock(mime="application/pdf")
        response = await client.post(
            "/api/admin/upload",
            files={"file": ("manual.pdf", pdf_magic, "application/pdf")},
            headers={"Authorization": f"Bearer {_admin()}"},
        )
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "processing"
    assert data["file_name"] == "manual.pdf"


@pytest.mark.anyio
async def test_upload_txt_accepted(client):
    """Plain-text uploads pass validation without magic bytes."""
    from db.connection import get_db
    from main import app
    app.dependency_overrides[get_db] = make_db_override()
    with patch("routers.admin.save_file", return_value="/data/txts/notas.txt"), \
         patch("routers.admin._process_and_index"):
        response = await client.post(
            "/api/admin/upload",
            files={"file": ("notas.txt", "Texto de prueba en español.".encode("utf-8"), "text/plain")},
            headers={"Authorization": f"Bearer {_admin()}"},
        )
    assert response.status_code == 200
    assert response.json()["status"] == "processing"


@pytest.mark.anyio
async def test_upload_docx_accepted(client):
    """DOCX validated via Office Open XML magic bytes."""
    from db.connection import get_db
    from main import app
    app.dependency_overrides[get_db] = make_db_override()
    docx_mime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    with patch("routers.admin.save_file", return_value="/data/docxs/manual.docx"), \
         patch("routers.admin._process_and_index"), \
         patch("routers.admin.filetype.guess") as mock_guess:
        mock_guess.return_value = MagicMock(mime=docx_mime)
        response = await client.post(
            "/api/admin/upload",
            files={"file": ("manual.docx", b"PK\x03\x04" + b"\x00" * 600, docx_mime)},
            headers={"Authorization": f"Bearer {_admin()}"},
        )
    assert response.status_code == 200
    assert response.json()["status"] == "processing"


@pytest.mark.anyio
async def test_upload_docx_rejects_wrong_magic_bytes(client):
    """A non-OOXML file renamed to .docx must be rejected."""
    from db.connection import get_db
    from main import app
    app.dependency_overrides[get_db] = make_db_override()
    with patch("routers.admin.filetype.guess", return_value=None):
        response = await client.post(
            "/api/admin/upload",
            files={"file": ("fake.docx", b"not a real docx", "application/octet-stream")},
            headers={"Authorization": f"Bearer {_admin()}"},
        )
    assert response.status_code == 400


# ── Documents list ─────────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_documents_list_requires_auth(client):
    response = await client.get("/api/admin/documents")
    assert response.status_code == 401


@pytest.mark.anyio
async def test_documents_list_requires_admin(client):
    from db.connection import get_db
    from main import app
    app.dependency_overrides[get_db] = make_db_override()
    response = await client.get(
        "/api/admin/documents",
        headers={"Authorization": f"Bearer {_user()}"},
    )
    app.dependency_overrides.clear()
    assert response.status_code == 403


@pytest.mark.anyio
async def test_documents_list_returns_array(client):
    from db.connection import get_db
    from main import app

    async def mock_db():
        session = AsyncMock()
        result = MagicMock()
        result.fetchall.return_value = []
        session.execute = AsyncMock(return_value=result)
        yield session

    app.dependency_overrides[get_db] = mock_db
    response = await client.get(
        "/api/admin/documents",
        headers={"Authorization": f"Bearer {_admin()}"},
    )
    assert response.status_code == 200
    assert isinstance(response.json(), list)


# ── Delete document ────────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_delete_document_requires_admin(client):
    from db.connection import get_db
    from main import app
    app.dependency_overrides[get_db] = make_db_override()
    response = await client.delete(
        "/api/admin/documents/manual.pdf",
        headers={"Authorization": f"Bearer {_user()}"},
    )
    app.dependency_overrides.clear()
    assert response.status_code == 403


# ── Excerpt ────────────────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_excerpt_requires_auth(client):
    import uuid
    response = await client.get(f"/api/admin/documents/excerpt/{uuid.uuid4()}")
    assert response.status_code == 401


@pytest.mark.anyio
async def test_excerpt_allows_regular_user(client):
    # Source-reference viewing is available to any authenticated user, not just
    # admins (the chat SourcePanel uses it). A missing chunk → 404, never 403.
    import uuid
    from db.connection import get_db
    from main import app
    app.dependency_overrides[get_db] = make_db_override(user=None)
    response = await client.get(
        f"/api/admin/documents/excerpt/{uuid.uuid4()}",
        headers={"Authorization": f"Bearer {_user()}"},
    )
    app.dependency_overrides.clear()
    assert response.status_code == 404


@pytest.mark.anyio
async def test_excerpt_returns_content_for_regular_user(client):
    # A regular user must receive the actual chunk content (the SourcePanel
    # renders it). Guards against re-locking this endpoint behind admin.
    import uuid
    from types import SimpleNamespace
    from db.connection import get_db
    from main import app
    cid = uuid.uuid4()
    chunk = SimpleNamespace(
        id=cid, file_name="manual.pdf", source_type="pdf",
        page_number=3, content="texto del fragmento",
    )
    app.dependency_overrides[get_db] = make_db_override(user=chunk)
    response = await client.get(
        f"/api/admin/documents/excerpt/{cid}",
        headers={"Authorization": f"Bearer {_user()}"},
    )
    app.dependency_overrides.clear()
    assert response.status_code == 200
    body = response.json()
    assert body["file_name"] == "manual.pdf"
    assert body["content"] == "texto del fragmento"
    assert body["page_number"] == 3


@pytest.mark.anyio
async def test_excerpt_returns_404_for_missing_chunk(client):
    import uuid
    from db.connection import get_db
    from main import app
    app.dependency_overrides[get_db] = make_db_override(user=None)
    response = await client.get(
        f"/api/admin/documents/excerpt/{uuid.uuid4()}",
        headers={"Authorization": f"Bearer {_admin()}"},
    )
    assert response.status_code == 404


@pytest.mark.anyio
async def test_excerpt_returns_422_for_invalid_id(client):
    from db.connection import get_db
    from main import app
    app.dependency_overrides[get_db] = make_db_override()
    response = await client.get(
        "/api/admin/documents/excerpt/not-a-uuid",
        headers={"Authorization": f"Bearer {_admin()}"},
    )
    assert response.status_code == 422


# ── Serve document ─────────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_serve_requires_auth(client):
    response = await client.get("/api/admin/documents/serve/pdfs/test.pdf")
    assert response.status_code == 401


@pytest.mark.anyio
async def test_serve_accessible_to_regular_user(client):
    """Any authenticated user can fetch source documents (file not found → 404, not 403)."""
    from db.connection import get_db
    from main import app
    app.dependency_overrides[get_db] = make_db_override()
    response = await client.get(
        "/api/admin/documents/serve/pdfs/test.pdf",
        headers={"Authorization": f"Bearer {_user()}"},
    )
    app.dependency_overrides.clear()
    assert response.status_code == 404
