import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from tests.conftest import make_db_override, make_jwt


@pytest.mark.anyio
async def test_upload_requires_auth(client):
    response = await client.post(
        "/api/admin/upload",
        files={"file": ("test.pdf", b"content", "application/pdf")},
    )
    assert response.status_code == 403  # HTTPBearer returns 403 when no token


@pytest.mark.anyio
async def test_upload_rejects_unsupported_type(client):
    from db.connection import get_db
    from main import app
    token = make_jwt()
    app.dependency_overrides[get_db] = make_db_override()
    response = await client.post(
        "/api/admin/upload",
        files={"file": ("test.txt", b"content", "text/plain")},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 400


@pytest.mark.anyio
async def test_upload_pdf_accepted(client):
    from db.connection import get_db
    from main import app
    token = make_jwt()
    app.dependency_overrides[get_db] = make_db_override()
    with patch("routers.admin.save_file", return_value="/data/pdfs/manual.pdf"):
        response = await client.post(
            "/api/admin/upload",
            files={"file": ("manual.pdf", b"%PDF-1.4 content", "application/pdf")},
            headers={"Authorization": f"Bearer {token}"},
        )
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "processing"
    assert data["file_name"] == "manual.pdf"


@pytest.mark.anyio
async def test_documents_list_requires_auth(client):
    response = await client.get("/api/admin/documents")
    assert response.status_code == 403  # HTTPBearer returns 403 when no token


@pytest.mark.anyio
async def test_documents_list_returns_array(client):
    from db.connection import get_db
    from main import app
    token = make_jwt()

    async def mock_db():
        session = AsyncMock()
        result = MagicMock()
        result.scalars.return_value.all.return_value = []
        session.execute = AsyncMock(return_value=result)
        yield session

    app.dependency_overrides[get_db] = mock_db
    response = await client.get(
        "/api/admin/documents",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 200
    assert isinstance(response.json(), list)
