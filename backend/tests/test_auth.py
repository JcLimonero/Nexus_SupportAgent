import pytest
import jwt as PyJWT


@pytest.mark.anyio
async def test_login_returns_token(client):
    response = await client.post(
        "/api/auth/login",
        json={"email": "user@example.com", "password": "anything"},
    )
    assert response.status_code == 200
    data = response.json()
    assert "access_token" in data
    assert data["token_type"] == "bearer"
    assert data["email"] == "user@example.com"


@pytest.mark.anyio
async def test_token_contains_uid(client):
    response = await client.post(
        "/api/auth/login",
        json={"email": "user@example.com", "password": "pw"},
    )
    token = response.json()["access_token"]
    payload = PyJWT.decode(token, options={"verify_signature": False})
    assert payload["uid"] == "user@example.com"
    assert payload["email"] == "user@example.com"


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
