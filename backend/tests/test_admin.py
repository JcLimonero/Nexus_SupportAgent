import pytest
from unittest.mock import AsyncMock, MagicMock, patch
import io


@pytest.mark.anyio
async def test_upload_requires_auth(client):
    response = await client.post(
        "/api/admin/upload",
        files={"file": ("test.pdf", b"content", "application/pdf")},
    )
    assert response.status_code == 401


@pytest.mark.anyio
async def test_upload_rejects_unsupported_type(client, auth_token):
    with patch("routers.admin.get_db") as mock_db:
        mock_db.return_value.__aenter__ = AsyncMock(return_value=AsyncMock())
        mock_db.return_value.__aexit__ = AsyncMock(return_value=False)

        response = await client.post(
            "/api/admin/upload",
            files={"file": ("test.txt", b"content", "text/plain")},
            headers={"Authorization": f"Bearer {auth_token}"},
        )
        assert response.status_code == 400


@pytest.mark.anyio
async def test_upload_pdf_accepted(client, auth_token):
    with patch("routers.admin.get_db") as mock_db, \
         patch("routers.admin.BackgroundTasks.add_task"), \
         patch("routers.admin._save_file_local", return_value="/data/pdfs/test.pdf"):

        mock_db.return_value.__aenter__ = AsyncMock(return_value=AsyncMock())
        mock_db.return_value.__aexit__ = AsyncMock(return_value=False)

        response = await client.post(
            "/api/admin/upload",
            files={"file": ("manual.pdf", b"%PDF-1.4 content", "application/pdf")},
            headers={"Authorization": f"Bearer {auth_token}"},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "processing"
        assert data["file_name"] == "manual.pdf"


@pytest.mark.anyio
async def test_documents_list_requires_auth(client):
    response = await client.get("/api/admin/documents")
    assert response.status_code == 401


@pytest.mark.anyio
async def test_documents_list_returns_array(client, auth_token):
    with patch("routers.admin.get_db") as mock_db:
        mock_session = AsyncMock()
        mock_result = MagicMock()
        mock_result.all.return_value = []
        mock_session.execute = AsyncMock(return_value=mock_result)
        mock_session.close = AsyncMock()
        mock_db.return_value.__aenter__ = AsyncMock(return_value=mock_session)
        mock_db.return_value.__aexit__ = AsyncMock(return_value=False)

        response = await client.get(
            "/api/admin/documents",
            headers={"Authorization": f"Bearer {auth_token}"},
        )
        assert response.status_code == 200
        assert isinstance(response.json(), list)
