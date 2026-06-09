import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from tests.conftest import make_db_override, make_jwt


def _user(email="u@x.com", is_admin=False, is_active=True, uid=None):
    u = MagicMock()
    u.id = uid or uuid.uuid4()
    u.email = email
    u.is_admin = is_admin
    u.is_active = is_active
    return u


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
    from db.connection import get_db
    from main import app

    admin_token = make_jwt(email="admin@x.com", is_admin=True, uid="11111111-1111-1111-1111-111111111111")
    admin_user = _user("admin@x.com", is_admin=True)

    async def mock_db():
        session = AsyncMock()
        result = MagicMock()
        result.scalars.return_value.all.return_value = [admin_user]
        session.execute = AsyncMock(return_value=result)
        yield session

    app.dependency_overrides[get_db] = mock_db
    response = await client.get("/api/users", headers={"Authorization": f"Bearer {admin_token}"})
    assert response.status_code == 200
    assert isinstance(response.json(), list)


@pytest.mark.anyio
async def test_create_user_conflict(client):
    from db.connection import get_db
    from main import app

    admin_token = make_jwt(email="admin@x.com", is_admin=True)
    existing = _user("existing@x.com")
    app.dependency_overrides[get_db] = make_db_override(user=existing)

    response = await client.post(
        "/api/users",
        headers={"Authorization": f"Bearer {admin_token}"},
        json={"email": "existing@x.com", "password": "Pass1234!", "is_admin": False},
    )
    assert response.status_code == 409


@pytest.mark.anyio
async def test_delete_self_forbidden(client):
    from db.connection import get_db
    from main import app

    user_id = str(uuid.uuid4())
    admin_token = make_jwt(email="admin@x.com", is_admin=True, uid=user_id)
    target = _user(uid=uuid.UUID(user_id))
    app.dependency_overrides[get_db] = make_db_override(user=target)

    response = await client.delete(
        f"/api/users/{user_id}",
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert response.status_code == 400
