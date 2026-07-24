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


# ── Create (signed-in users only) ─────────────────────────────────────────────

@pytest.mark.anyio
async def test_create_requires_auth(client):
    response = await client.post("/api/escalations", json={"contact": "555-1234"})
    assert response.status_code == 401


@pytest.mark.anyio
async def test_guest_cannot_create(client):
    response = await client.post(
        "/api/escalations",
        json={"contact": "555-1234", "reason": "necesito ayuda"},
        headers={"Authorization": f"Bearer {_guest_jwt()}"},
    )
    assert response.status_code == 403


@pytest.mark.anyio
async def test_user_can_create(client):
    response = await client.post(
        "/api/escalations",
        json={"contact": "555-1234", "reason": "necesito ayuda"},
        headers={"Authorization": f"Bearer {make_jwt()}"},
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


@pytest.mark.anyio
async def test_create_accepts_attachments(client):
    response = await client.post(
        "/api/escalations",
        json={
            "contact": "555-1234",
            "attachments": [{"file_name": "captura.png", "url": "/data/escalations/abc_captura.png", "content_type": "image/png", "size": 1234}],
        },
        headers={"Authorization": f"Bearer {make_jwt()}"},
    )
    assert response.status_code == 201


@pytest.mark.anyio
async def test_create_rejects_foreign_attachment_url(client):
    # A URL outside /data/escalations/ (e.g. pointing at an indexed KB doc) → 422.
    response = await client.post(
        "/api/escalations",
        json={
            "contact": "555-1234",
            "attachments": [{"file_name": "secreto.pdf", "url": "/data/pdfs/secreto.pdf"}],
        },
        headers={"Authorization": f"Bearer {make_jwt()}"},
    )
    assert response.status_code == 422


# ── Attachment upload ─────────────────────────────────────────────────────────

_PNG_BYTES = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64


@pytest.mark.anyio
async def test_attachment_upload_requires_auth(client):
    response = await client.post(
        "/api/escalations/attachments",
        files={"file": ("x.png", _PNG_BYTES, "image/png")},
    )
    assert response.status_code == 401


@pytest.mark.anyio
async def test_attachment_upload_rejects_bad_extension(client):
    response = await client.post(
        "/api/escalations/attachments",
        files={"file": ("malware.exe", b"MZ....", "application/octet-stream")},
        headers={"Authorization": f"Bearer {make_jwt()}"},
    )
    assert response.status_code == 400


@pytest.mark.anyio
async def test_attachment_upload_rejects_spoofed_image(client):
    # .png extension but the bytes are plain text → magic-byte check fails.
    response = await client.post(
        "/api/escalations/attachments",
        files={"file": ("fake.png", b"just plain text, not a png", "image/png")},
        headers={"Authorization": f"Bearer {make_jwt()}"},
    )
    assert response.status_code == 400


@pytest.mark.anyio
async def test_guest_cannot_upload(client):
    response = await client.post(
        "/api/escalations/attachments",
        files={"file": ("x.png", _PNG_BYTES, "image/png")},
        headers={"Authorization": f"Bearer {_guest_jwt()}"},
    )
    assert response.status_code == 403


@pytest.mark.anyio
async def test_user_can_upload_image(client):
    from routers import escalations
    with patch.object(escalations, "save_file", return_value="/data/escalations/xyz_x.png"):
        response = await client.post(
            "/api/escalations/attachments",
            files={"file": ("x.png", _PNG_BYTES, "image/png")},
            headers={"Authorization": f"Bearer {make_jwt()}"},
        )
    assert response.status_code == 201
    body = response.json()
    assert body["url"] == "/data/escalations/xyz_x.png"
    assert body["content_type"] == "image/png"


@pytest.mark.anyio
async def test_attachment_upload_rejects_oversized_file(client):
    from routers.escalations import _ATTACH_MAX_BYTES
    big = _PNG_BYTES + b"\x00" * (_ATTACH_MAX_BYTES + 1 - len(_PNG_BYTES))
    response = await client.post(
        "/api/escalations/attachments",
        files={"file": ("grande.png", big, "image/png")},
        headers={"Authorization": f"Bearer {make_jwt()}"},
    )
    assert response.status_code == 413


@pytest.mark.anyio
async def test_upload_rejected_when_disk_low(client):
    import types
    from routers import escalations
    fake = types.SimpleNamespace(total=0, used=0, free=1 * 1024 * 1024)  # 1 MB free
    with patch.object(escalations.shutil, "disk_usage", return_value=fake):
        response = await client.post(
            "/api/escalations/attachments",
            files={"file": ("x.png", _PNG_BYTES, "image/png")},
            headers={"Authorization": f"Bearer {make_jwt()}"},
        )
    assert response.status_code == 507


# ── Abuse guards ──────────────────────────────────────────────────────────────

def test_client_ip_extraction():
    from main import _client_ip, settings

    scope = {"client": ("10.0.0.9", 5000), "headers": [
        (b"x-forwarded-for", b"1.1.1.1, 2.2.2.2, 3.3.3.3"),
    ]}
    orig = settings.trusted_proxy_hops
    try:
        settings.trusted_proxy_hops = 0
        assert _client_ip(scope) == "10.0.0.9"          # no proxy → direct peer
        settings.trusted_proxy_hops = 2
        assert _client_ip(scope) == "2.2.2.2"           # client sits 2 from the right
        # Fewer entries than hops → first entry (best effort).
        scope["headers"] = [(b"x-forwarded-for", b"9.9.9.9")]
        assert _client_ip(scope) == "9.9.9.9"
        # No XFF header → direct peer.
        scope["headers"] = []
        assert _client_ip(scope) == "10.0.0.9"
    finally:
        settings.trusted_proxy_hops = orig


# ── Email helper (EmailJS, best-effort) ───────────────────────────────────────

def test_emailjs_skipped_when_unconfigured():
    from routers import escalations
    with patch("urllib.request.urlopen") as urlopen:
        escalations._send_via_emailjs({})  # EmailJS ids are "" in tests
    urlopen.assert_not_called()


def test_emailjs_swallows_errors():
    from routers import escalations
    with patch.object(escalations.settings, "emailjs_service_id", "svc"), \
         patch.object(escalations.settings, "emailjs_template_id", "tpl"), \
         patch.object(escalations.settings, "emailjs_public_key", "pub"), \
         patch("urllib.request.urlopen", side_effect=OSError("connection refused")):
        # Must not raise — the escalation is already saved; email is a bonus.
        escalations._send_via_emailjs({"contact": "x"})


def test_emailjs_payload_shape():
    import json as _json
    from routers import escalations

    captured = {}

    class _Resp:
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def read(self): return b"OK"

    def _fake_urlopen(req, timeout=None):
        captured["body"] = _json.loads(req.data.decode())
        return _Resp()

    with patch.object(escalations.settings, "emailjs_service_id", "svc"), \
         patch.object(escalations.settings, "emailjs_template_id", "tpl"), \
         patch.object(escalations.settings, "emailjs_public_key", "pub"), \
         patch.object(escalations.settings, "emailjs_private_key", "priv"), \
         patch("urllib.request.urlopen", _fake_urlopen):
        escalations._send_via_emailjs({"contact": "ana@example.com"})

    body = captured["body"]
    assert body["service_id"] == "svc" and body["template_id"] == "tpl"
    assert body["user_id"] == "pub" and body["accessToken"] == "priv"
    assert body["template_params"]["contact"] == "ana@example.com"


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
    stub.attachments = [{"file_name": "captura.png", "url": "/data/escalations/a_captura.png", "content_type": "image/png", "size": 10}]
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
    assert data["items"][0]["attachments"][0]["file_name"] == "captura.png"


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
