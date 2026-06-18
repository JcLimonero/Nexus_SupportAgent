import uuid
from unittest.mock import MagicMock

import jwt as PyJWT
import pytest

from tests.conftest import make_db_override, make_jwt


def _user(email="user@example.com", is_admin=False, is_active=True):
    u = MagicMock()
    u.id = uuid.UUID("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")
    u.email = email
    u.is_admin = is_admin
    u.is_active = is_active
    u.hashed_password = "$2b$12$placeholder"
    return u


@pytest.mark.anyio
async def test_login_wrong_password(client):
    from db.connection import get_db
    from main import app
    app.dependency_overrides[get_db] = make_db_override(user=None)
    response = await client.post("/api/auth/login", json={"email": "x@x.com", "password": "wrong"})
    assert response.status_code == 401


@pytest.mark.anyio
async def test_login_inactive_user(client):
    from unittest.mock import patch
    from db.connection import get_db
    from main import app
    app.dependency_overrides[get_db] = make_db_override(user=_user(is_active=False))
    with patch("auth.local_auth.verify_password", return_value=True):
        response = await client.post("/api/auth/login", json={"email": "x@x.com", "password": "any"})
    assert response.status_code == 401


@pytest.mark.anyio
async def test_login_success_returns_token(client):
    from unittest.mock import patch
    from db.connection import get_db
    from main import app
    app.dependency_overrides[get_db] = make_db_override(user=_user())
    with patch("auth.local_auth.verify_password", return_value=True):
        response = await client.post("/api/auth/login", json={"email": "user@example.com", "password": "correct"})
    assert response.status_code == 200
    data = response.json()
    assert "access_token" in data
    assert data["email"] == "user@example.com"
    assert "is_admin" in data


@pytest.mark.anyio
async def test_token_contains_is_admin(client):
    from unittest.mock import patch
    from db.connection import get_db
    from main import app
    app.dependency_overrides[get_db] = make_db_override(user=_user(is_admin=True))
    with patch("auth.local_auth.verify_password", return_value=True):
        response = await client.post("/api/auth/login", json={"email": "admin@example.com", "password": "pw"})
    token = response.json()["access_token"]
    payload = PyJWT.decode(token, options={"verify_signature": False})
    assert payload["is_admin"] is True


# ── Anonymous / guest access ──────────────────────────────────────────────────

@pytest.mark.anyio
async def test_guest_token_issued(client):
    response = await client.post("/api/auth/guest")
    assert response.status_code == 200
    data = response.json()
    assert data["is_anon"] is True
    assert data["is_admin"] is False
    assert data["email"].startswith("Invitado #")
    # The minted token must carry is_anon and a non-admin anon uid.
    payload = PyJWT.decode(data["access_token"], options={"verify_signature": False})
    assert payload["is_anon"] is True
    assert payload["is_admin"] is False
    assert payload["uid"].startswith("anon:")


@pytest.mark.anyio
async def test_guest_token_disabled_returns_403(client):
    from unittest.mock import patch
    import auth.local_auth as la
    with patch.object(la.settings, "allow_anonymous", False):
        response = await client.post("/api/auth/guest")
    assert response.status_code == 403


@pytest.mark.anyio
async def test_guest_cannot_reach_admin(client):
    """A guest token must not unlock admin endpoints (no privilege escalation)."""
    gtok = (await client.post("/api/auth/guest")).json()["access_token"]
    response = await client.get(
        "/api/admin/conversations",
        headers={"Authorization": f"Bearer {gtok}"},
    )
    assert response.status_code == 403


@pytest.mark.anyio
async def test_protected_endpoint_requires_token(client):
    response = await client.get("/api/sessions")
    assert response.status_code == 401  # HTTPBearer returns 401 when no token provided


@pytest.mark.anyio
async def test_protected_endpoint_rejects_bad_token(client):
    response = await client.get(
        "/api/sessions",
        headers={"Authorization": "Bearer not-a-real-token"},
    )
    assert response.status_code == 401
