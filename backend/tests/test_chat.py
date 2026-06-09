import pytest
from unittest.mock import AsyncMock, MagicMock, patch


def _mock_db_session():
    session = AsyncMock()
    session.execute = AsyncMock(return_value=MagicMock(scalars=MagicMock(return_value=MagicMock(all=MagicMock(return_value=[])))))
    session.add = MagicMock()
    session.commit = AsyncMock()
    session.refresh = AsyncMock()
    session.close = AsyncMock()
    return session


@pytest.mark.anyio
async def test_chat_requires_auth(client):
    response = await client.post("/api/chat", json={"message": "hola"})
    assert response.status_code == 401


@pytest.mark.anyio
async def test_chat_validates_empty_message(client, auth_token):
    with patch("routers.chat.get_db") as mock_db:
        mock_db.return_value.__aenter__ = AsyncMock(return_value=_mock_db_session())
        mock_db.return_value.__aexit__ = AsyncMock(return_value=False)

        response = await client.post(
            "/api/chat",
            json={"message": ""},
            headers={"Authorization": f"Bearer {auth_token}"},
        )
        assert response.status_code == 422


@pytest.mark.anyio
async def test_chat_returns_answer_structure(client, auth_token):
    with patch("routers.chat.get_db") as mock_db, \
         patch("routers.chat.search_chunks", new_callable=AsyncMock, return_value=[]), \
         patch("routers.chat.build_context", return_value=("sin contexto", [], [])), \
         patch("routers.chat.asyncio.to_thread", new_callable=AsyncMock, return_value="Respuesta de prueba"):

        mock_session = _mock_db_session()
        mock_db.return_value.__aenter__ = AsyncMock(return_value=mock_session)
        mock_db.return_value.__aexit__ = AsyncMock(return_value=False)

        response = await client.post(
            "/api/chat",
            json={"message": "Que es TotalDealer?"},
            headers={"Authorization": f"Bearer {auth_token}"},
        )
        assert response.status_code == 200
        data = response.json()
        assert "answer" in data
        assert "session_id" in data
        assert "pdf_sources" in data
        assert "video_sources" in data
        assert isinstance(data["pdf_sources"], list)
        assert isinstance(data["video_sources"], list)


@pytest.mark.anyio
async def test_sessions_list(client, auth_token):
    with patch("routers.chat.get_db") as mock_db:
        mock_session = AsyncMock()
        mock_result = MagicMock()
        mock_result.scalars.return_value.all.return_value = []
        mock_session.execute = AsyncMock(return_value=mock_result)
        mock_session.close = AsyncMock()
        mock_db.return_value.__aenter__ = AsyncMock(return_value=mock_session)
        mock_db.return_value.__aexit__ = AsyncMock(return_value=False)

        response = await client.get(
            "/api/sessions",
            headers={"Authorization": f"Bearer {auth_token}"},
        )
        assert response.status_code == 200
        assert isinstance(response.json(), list)
