import pytest
from unittest.mock import AsyncMock, MagicMock, patch
import uuid


def _make_user(email="u@x.com", is_admin=False, is_active=True, uid=None):
    u = MagicMock()
    u.id = uid or uuid.uuid4()
    u.email = email
    u.is_admin = is_admin
    u.is_active = is_active
    return u


def _admin_token(client_fixture):
    """Helper — returns the auth token fixture value from a mock admin user."""
    pass


@pytest.mark.anyio
async def test_list_users_requires_admin(client, auth_token):
    """Regular user (is_admin=False) gets 403."""
    response = await client.get(
        "/api/users",
        headers={"Authorization": f"Bearer {auth_token}"},
    )
    assert response.status_code == 403


@pytest.mark.anyio
async def test_list_users_as_admin(client):
    with patch("auth.firebase_verify.settings") as mock_settings, \
         patch("auth.local_auth.verify_local_token") as mock_verify, \
         patch("routers.users.get_db") as mock_db:

        mock_settings.auth_provider = "local"
        mock_verify.return_value = {"uid": "admin-id", "email": "admin@x.com", "is_admin": True}

        mock_session = AsyncMock()
        mock_result = MagicMock()
        mock_result.scalars.return_value.all.return_value = [_make_user("a@x.com", is_admin=True)]
        mock_session.execute = AsyncMock(return_value=mock_result)
        mock_session.close = AsyncMock()
        mock_db.return_value.__aenter__ = AsyncMock(return_value=mock_session)
        mock_db.return_value.__aexit__ = AsyncMock(return_value=False)

        response = await client.get(
            "/api/users",
            headers={"Authorization": "Bearer fake-admin-token"},
        )
        assert response.status_code == 200
        assert isinstance(response.json(), list)


@pytest.mark.anyio
async def test_create_user_conflict(client):
    with patch("auth.local_auth.verify_local_token") as mock_verify, \
         patch("routers.users.get_db") as mock_db:

        mock_verify.return_value = {"uid": "admin-id", "email": "admin@x.com", "is_admin": True}

        mock_session = AsyncMock()
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = _make_user("existing@x.com")
        mock_session.execute = AsyncMock(return_value=mock_result)
        mock_session.close = AsyncMock()
        mock_db.return_value.__aenter__ = AsyncMock(return_value=mock_session)
        mock_db.return_value.__aexit__ = AsyncMock(return_value=False)

        response = await client.post(
            "/api/users",
            headers={"Authorization": "Bearer fake-admin-token"},
            json={"email": "existing@x.com", "password": "Pass1234!", "is_admin": False},
        )
        assert response.status_code == 409


@pytest.mark.anyio
async def test_delete_self_forbidden(client):
    user_id = str(uuid.uuid4())
    with patch("auth.local_auth.verify_local_token") as mock_verify, \
         patch("routers.users.get_db") as mock_db:

        mock_verify.return_value = {"uid": user_id, "email": "admin@x.com", "is_admin": True}

        mock_session = AsyncMock()
        mock_result = MagicMock()
        u = _make_user(uid=uuid.UUID(user_id))
        mock_result.scalar_one_or_none.return_value = u
        mock_session.execute = AsyncMock(return_value=mock_result)
        mock_session.close = AsyncMock()
        mock_db.return_value.__aenter__ = AsyncMock(return_value=mock_session)
        mock_db.return_value.__aexit__ = AsyncMock(return_value=False)

        response = await client.delete(
            f"/api/users/{user_id}",
            headers={"Authorization": "Bearer fake-admin-token"},
        )
        assert response.status_code == 400
