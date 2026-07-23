import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import jwt as PyJWT
import pytest

from tests.conftest import make_jwt, _jwt_secret


def _guest_jwt():
    payload = {
        "uid": f"anon:{uuid.uuid4().hex}",
        "email": "Invitado #ab12",
        "is_admin": False,
        "is_anon": True,
        "exp": datetime.now(timezone.utc) + timedelta(hours=1),
    }
    return PyJWT.encode(payload, _jwt_secret(), algorithm="HS256")


# ── Create (any authenticated user) ───────────────────────────────────────────

@pytest.mark.anyio
async def test_create_requires_auth(client):
    response = await client.post("/api/escalations", json={"contact": "555-1234"})
    assert response.status_code == 401


@pytest.mark.anyio
async def test_guest_can_create(client):
    response = await client.post(
        "/api/escalations",
        json={"contact": "555-1234", "reason": "necesito ayuda"},
        headers={"Authorization": f"Bearer {_guest_jwt()}"},
    )
    assert response.status_code == 201


@pytest.mark.anyio
async def test_create_rejects_short_contact(client):
    response = await client.post(
        "/api/escalations",
        json={"contact": "ab"},
        headers={"Authorization": f"Bearer {make_jwt()}"},
    )
    assert response.status_code == 422


@pytest.mark.anyio
async def test_create_rejects_missing_contact(client):
    response = await client.post(
        "/api/escalations",
        json={"reason": "sin contacto"},
        headers={"Authorization": f"Bearer {make_jwt()}"},
    )
    assert response.status_code == 422


@pytest.mark.anyio
async def test_create_rejects_invalid_session_uuid(client):
    response = await client.post(
        "/api/escalations",
        json={"contact": "555-1234", "session_id": "not-a-uuid"},
        headers={"Authorization": f"Bearer {make_jwt()}"},
    )
    assert response.status_code == 422


# ── Email helper (best-effort) ────────────────────────────────────────────────

def test_send_email_skipped_when_unconfigured():
    from routers import escalations
    with patch("smtplib.SMTP") as smtp:
        escalations._send_email("subj", "body")  # settings.smtp_host is "" in tests
    smtp.assert_not_called()


def test_send_email_swallows_errors():
    from routers import escalations
    with patch.object(escalations.settings, "smtp_host", "smtp.test"), \
         patch.object(escalations.settings, "escalation_notify_email", "s@test.com"), \
         patch("smtplib.SMTP", side_effect=OSError("connection refused")):
        # Must not raise — the escalation is already saved; email is a bonus.
        escalations._send_email("subj", "body")


# ── Admin list / update ───────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_list_requires_admin(client):
    response = await client.get(
        "/api/admin/escalations",
        headers={"Authorization": f"Bearer {make_jwt(is_admin=False)}"},
    )
    assert response.status_code == 403


@pytest.mark.anyio
async def test_patch_requires_admin(client):
    response = await client.patch(
        f"/api/admin/escalations/{uuid.uuid4()}",
        json={"status": "resolved"},
        headers={"Authorization": f"Bearer {make_jwt(is_admin=False)}"},
    )
    assert response.status_code == 403


@pytest.mark.anyio
async def test_patch_rejects_invalid_status(client):
    response = await client.patch(
        f"/api/admin/escalations/{uuid.uuid4()}",
        json={"status": "banana"},
        headers={"Authorization": f"Bearer {make_jwt(is_admin=True)}"},
    )
    assert response.status_code == 422


@pytest.mark.anyio
async def test_patch_rejects_invalid_uuid(client):
    response = await client.patch(
        "/api/admin/escalations/not-a-uuid",
        json={"status": "resolved"},
        headers={"Authorization": f"Bearer {make_jwt(is_admin=True)}"},
    )
    assert response.status_code == 422


@pytest.mark.anyio
async def test_list_returns_items(client):
    from db.connection import get_db
    from main import app

    stub = MagicMock()
    stub.id = uuid.uuid4()
    stub.session_id = uuid.uuid4()
    stub.user_label = "test@nexus.local"
    stub.contact = "555-1234"
    stub.name = "Ana"
    stub.reason = "necesito ayuda"
    stub.status = "new"
    stub.created_at = datetime(2026, 1, 1, 12, 0, 0)

    async def _override():
        session = AsyncMock()
        result = MagicMock()
        result.scalars.return_value.all.return_value = [stub]
        result.scalar_one.return_value = 1
        session.execute = AsyncMock(return_value=result)
        yield session

    app.dependency_overrides[get_db] = _override
    response = await client.get(
        "/api/admin/escalations",
        headers={"Authorization": f"Bearer {make_jwt(is_admin=True)}"},
    )
    app.dependency_overrides.clear()
    assert response.status_code == 200
    data = response.json()
    assert data["new_count"] == 1
    assert data["items"][0]["contact"] == "555-1234"
    assert data["items"][0]["status"] == "new"


@pytest.mark.anyio
async def test_patch_updates_status(client):
    from db.connection import get_db
    from main import app

    async def _override():
        session = AsyncMock()
        result = MagicMock()
        result.first.return_value = (uuid.uuid4(),)  # row found → not 404
        session.execute = AsyncMock(return_value=result)
        session.commit = AsyncMock()
        yield session

    app.dependency_overrides[get_db] = _override
    eid = str(uuid.uuid4())
    response = await client.patch(
        f"/api/admin/escalations/{eid}",
        json={"status": "resolved"},
        headers={"Authorization": f"Bearer {make_jwt(is_admin=True)}"},
    )
    app.dependency_overrides.clear()
    assert response.status_code == 200
    assert response.json()["status"] == "resolved"


@pytest.mark.anyio
async def test_patch_404_when_not_found(client):
    # Default override yields result.first() → None → 404.
    response = await client.patch(
        f"/api/admin/escalations/{uuid.uuid4()}",
        json={"status": "resolved"},
        headers={"Authorization": f"Bearer {make_jwt(is_admin=True)}"},
    )
    assert response.status_code == 404
