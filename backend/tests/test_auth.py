import pytest
from unittest.mock import AsyncMock, MagicMock, patch
import jwt as PyJWT


def _make_mock_user(email="user@example.com", is_admin=False, is_active=True):
    user = MagicMock()
    user.id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
    user.email = email
    user.is_admin = is_admin
    user.is_active = is_active
    user.hashed_password = "$2b$12$placeholder"
    return user


@pytest.mark.anyio
async def test_login_wrong_password(client):
    with patch("routers.chat.get_db"), patch("auth.local_auth.get_db") as mock_db:
        mock_session = AsyncMock()
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = None
        mock_session.execute = AsyncMock(return_value=mock_result)
        mock_session.close = AsyncMock()
        mock_db.return_value.__aenter__ = AsyncMock(return_value=mock_session)
        mock_db.return_value.__aexit__ = AsyncMock(return_value=False)

        response = await client.post(
            "/api/auth/login",
            json={"email": "user@example.com", "password": "wrong"},
        )
        assert response.status_code == 401


@pytest.mark.anyio
async def test_login_inactive_user(client):
    with patch("auth.local_auth.get_db") as mock_db, \
         patch("auth.local_auth.verify_password", return_value=True):
        mock_session = AsyncMock()
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = _make_mock_user(is_active=False)
        mock_session.execute = AsyncMock(return_value=mock_result)
        mock_session.close = AsyncMock()
        mock_db.return_value.__aenter__ = AsyncMock(return_value=mock_session)
        mock_db.return_value.__aexit__ = AsyncMock(return_value=False)

        response = await client.post(
            "/api/auth/login",
            json={"email": "user@example.com", "password": "any"},
        )
        assert response.status_code == 401


@pytest.mark.anyio
async def test_login_success_returns_token(client):
    with patch("auth.local_auth.get_db") as mock_db, \
         patch("auth.local_auth.verify_password", return_value=True):
        mock_session = AsyncMock()
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = _make_mock_user()
        mock_session.execute = AsyncMock(return_value=mock_result)
        mock_session.close = AsyncMock()
        mock_db.return_value.__aenter__ = AsyncMock(return_value=mock_session)
        mock_db.return_value.__aexit__ = AsyncMock(return_value=False)

        response = await client.post(
            "/api/auth/login",
            json={"email": "user@example.com", "password": "correct"},
        )
        assert response.status_code == 200
        data = response.json()
        assert "access_token" in data
        assert data["email"] == "user@example.com"
        assert "is_admin" in data


@pytest.mark.anyio
async def test_token_contains_is_admin(client):
    with patch("auth.local_auth.get_db") as mock_db, \
         patch("auth.local_auth.verify_password", return_value=True):
        mock_session = AsyncMock()
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = _make_mock_user(is_admin=True)
        mock_session.execute = AsyncMock(return_value=mock_result)
        mock_session.close = AsyncMock()
        mock_db.return_value.__aenter__ = AsyncMock(return_value=mock_session)
        mock_db.return_value.__aexit__ = AsyncMock(return_value=False)

        response = await client.post(
            "/api/auth/login",
            json={"email": "admin@example.com", "password": "pw"},
        )
        token = response.json()["access_token"]
        payload = PyJWT.decode(token, options={"verify_signature": False})
        assert payload["is_admin"] is True


@pytest.mark.anyio
async def test_protected_endpoint_requires_token(client):
    response = await client.get("/api/sessions")
    assert response.status_code == 401


@pytest.mark.anyio
async def test_protected_endpoint_rejects_bad_token(client):
    response = await client.get(
        "/api/sessions",
        headers={"Authorization": "Bearer not-a-real-token"},
    )
    assert response.status_code == 401
