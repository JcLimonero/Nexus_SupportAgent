import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
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

_REASON = "no puedo facturar un pedido de mostrador"

def _body(**overrides):
    body = {"name": "Ana", "email": "ana@example.com", "reason": _REASON}
    body.update(overrides)
    return body


@pytest.mark.anyio
async def test_create_requires_auth(client):
    response = await client.post("/api/escalations", json=_body())
    assert response.status_code == 401


@pytest.mark.anyio
async def test_guest_cannot_create(client):
    response = await client.post(
        "/api/escalations",
        json=_body(),
        headers={"Authorization": f"Bearer {_guest_jwt()}"},
    )
    assert response.status_code == 403


@pytest.mark.anyio
async def test_user_can_create_with_email(client):
    response = await client.post(
        "/api/escalations",
        json=_body(),
        headers={"Authorization": f"Bearer {make_jwt()}"},
    )
    assert response.status_code == 201


@pytest.mark.anyio
async def test_user_can_create_with_phone_only(client):
    # Formatting is stripped down to the 10 digits.
    response = await client.post(
        "/api/escalations",
        json=_body(email=None, phone="55 1234 5678"),
        headers={"Authorization": f"Bearer {make_jwt()}"},
    )
    assert response.status_code == 201


@pytest.mark.anyio
async def test_create_rejects_no_way_to_contact(client):
    response = await client.post(
        "/api/escalations",
        json={"name": "Ana", "reason": _REASON},
        headers={"Authorization": f"Bearer {make_jwt()}"},
    )
    assert response.status_code == 422


@pytest.mark.anyio
@pytest.mark.parametrize("name", [None, "", " "])
async def test_create_rejects_missing_name(client, name):
    body = _body()
    if name is None:
        del body["name"]
    else:
        body["name"] = name
    response = await client.post(
        "/api/escalations", json=body, headers={"Authorization": f"Bearer {make_jwt()}"},
    )
    assert response.status_code == 422


@pytest.mark.anyio
@pytest.mark.parametrize("email", ["ana", "ana@example", "ana @example.com", "@example.com"])
async def test_create_rejects_invalid_email(client, email):
    response = await client.post(
        "/api/escalations",
        json=_body(email=email),
        headers={"Authorization": f"Bearer {make_jwt()}"},
    )
    assert response.status_code == 422


@pytest.mark.anyio
@pytest.mark.parametrize("phone", ["551234567", "5512345678901", "abcdefghij"])
async def test_create_rejects_phone_without_ten_digits(client, phone):
    response = await client.post(
        "/api/escalations",
        json=_body(email=None, phone=phone),
        headers={"Authorization": f"Bearer {make_jwt()}"},
    )
    assert response.status_code == 422


@pytest.mark.anyio
async def test_create_rejects_missing_reason(client):
    response = await client.post(
        "/api/escalations",
        json={"name": "Ana", "email": "ana@example.com"},
        headers={"Authorization": f"Bearer {make_jwt()}"},
    )
    assert response.status_code == 422


@pytest.mark.anyio
async def test_create_rejects_whitespace_reason(client):
    # Stripped before the length check, so spaces can't pass for a description.
    response = await client.post(
        "/api/escalations",
        json=_body(reason="          "),
        headers={"Authorization": f"Bearer {make_jwt()}"},
    )
    assert response.status_code == 422


@pytest.mark.anyio
async def test_create_rejects_invalid_session_uuid(client):
    response = await client.post(
        "/api/escalations",
        json=_body(session_id="not-a-uuid"),
        headers={"Authorization": f"Bearer {make_jwt()}"},
    )
    assert response.status_code == 422


def test_contact_string_joins_email_and_phone():
    from routers.escalations import EscalationRequestBody
    body = EscalationRequestBody(name="Ana", email="Ana@Example.com ", phone="(55) 1234-5678", reason=_REASON)
    assert body.email == "ana@example.com" and body.phone == "5512345678"


@pytest.mark.anyio
async def test_create_accepts_attachments(client):
    response = await client.post(
        "/api/escalations",
        json=_body(
            attachments=[{"file_name": "captura.png", "url": "/data/escalations/abc_captura.png", "content_type": "image/png", "size": 1234}],
        ),
        headers={"Authorization": f"Bearer {make_jwt()}"},
    )
    assert response.status_code == 201


@pytest.mark.anyio
async def test_create_rejects_foreign_attachment_url(client):
    # A URL outside /data/escalations/ (e.g. pointing at an indexed KB doc) → 422.
    response = await client.post(
        "/api/escalations",
        json=_body(attachments=[{"file_name": "secreto.pdf", "url": "/data/pdfs/secreto.pdf"}]),
        headers={"Authorization": f"Bearer {make_jwt()}"},
    )
    assert response.status_code == 422


# ── Conversation snapshot (PDF + email text) ──────────────────────────────────

def _chat_db(session_obj, messages):
    """get_db override for the create path: first query → the chat session,
    second → its messages."""
    async def _override():
        db = AsyncMock()
        found = MagicMock()
        found.scalar_one_or_none.return_value = session_obj
        msgs = MagicMock()
        msgs.scalars.return_value.all.return_value = messages
        db.execute = AsyncMock(side_effect=[found, msgs])
        db.commit = AsyncMock()
        db.add = MagicMock()
        db.refresh = AsyncMock()
        yield db
    return _override


def _fake_messages():
    return [
        SimpleNamespace(role="user", content="¿Cómo facturo?", created_at=datetime(2026, 7, 24, 20, 0)),
        SimpleNamespace(role="assistant", content="Entra a Ventas.", created_at=datetime(2026, 7, 24, 20, 1)),
    ]


@pytest.mark.anyio
async def test_create_attaches_the_conversation(client):
    from db.connection import get_db
    from main import app
    from routers import escalations

    sid = uuid.uuid4()
    chat = SimpleNamespace(id=sid, title="Facturación", share_token=None)
    app.dependency_overrides[get_db] = _chat_db(chat, _fake_messages())

    notify = AsyncMock()
    with patch.object(escalations, "save_file", return_value="/data/escalations/abc_conversacion.pdf"), \
         patch.object(escalations, "_notify", notify), \
         patch.object(escalations.settings, "public_origin", "https://soporte.example"):
        response = await client.post(
            "/api/escalations",
            json=_body(session_id=str(sid)),
            headers={"Authorization": f"Bearer {make_jwt()}"},
        )
    app.dependency_overrides.clear()
    assert response.status_code == 201

    # The PDF is filed as the first attachment of the request…
    args = notify.await_args.args
    saved = args[0]
    assert saved.attachments[0]["file_name"] == "conversacion.pdf"
    assert saved.attachments[0]["url"].startswith("/data/escalations/")
    assert saved.attachments[0]["size"] > 0
    # …and the email gets the text, the public share link and the PDF bytes.
    conversation, share_link, pdf = args[1], args[2], args[3]
    assert "¿Cómo facturo?" in conversation and "Usuario · 24/07/2026 14:00" in conversation
    assert chat.share_token and share_link == f"https://soporte.example/shared/{chat.share_token}"
    assert pdf.startswith(b"%PDF")


@pytest.mark.anyio
async def test_create_skips_snapshot_for_someone_elses_session(client):
    """The session query is scoped to the requester, so a foreign id finds
    nothing: the ticket is still created, just without the conversation."""
    from db.connection import get_db
    from main import app
    from routers import escalations

    app.dependency_overrides[get_db] = _chat_db(None, [])
    notify = AsyncMock()
    with patch.object(escalations, "_notify", notify):
        response = await client.post(
            "/api/escalations",
            json=_body(session_id=str(uuid.uuid4())),
            headers={"Authorization": f"Bearer {make_jwt()}"},
        )
    app.dependency_overrides.clear()
    assert response.status_code == 201
    saved, conversation, _share, pdf, _html, _zip = notify.await_args.args
    assert saved.attachments == [] and conversation == "" and pdf is None


@pytest.mark.anyio
async def test_create_survives_a_broken_snapshot(client):
    """A ticket is never lost because the PDF failed."""
    from db.connection import get_db
    from main import app
    from routers import escalations

    chat = SimpleNamespace(id=uuid.uuid4(), title=None, share_token=None)
    app.dependency_overrides[get_db] = _chat_db(chat, _fake_messages())
    with patch.object(escalations, "render_pdf", side_effect=OSError("disk on fire")), \
         patch.object(escalations, "_notify", AsyncMock()):
        response = await client.post(
            "/api/escalations",
            json=_body(session_id=str(uuid.uuid4())),
            headers={"Authorization": f"Bearer {make_jwt()}"},
        )
    app.dependency_overrides.clear()
    assert response.status_code == 201


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
        captured["ua"] = req.get_header("User-agent")
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
    # Cloudflare 403s urllib's default UA ("error code: 1010") — keep our own.
    assert captured["ua"] and "urllib" not in captured["ua"].lower()


def _record_stub():
    return SimpleNamespace(
        name="Ana", user_label="ana@example.com", user_id="uid", contact="ana@example.com",
        reason=_REASON, attachments=[], session_id=None,
    )


@pytest.mark.anyio
async def test_notify_sends_conversation_link_and_pdf():
    from routers import escalations
    sent = []
    with patch.object(escalations, "_send_via_emailjs", lambda p: sent.append(p) or True):
        await escalations._notify(_record_stub(), "Usuario · hola", "https://x.mx/shared/tok", b"%PDF-1.7 fake")
    assert len(sent) == 1
    assert sent[0]["conversation"] == "Usuario · hola"
    assert sent[0]["share_link"] == "https://x.mx/shared/tok"
    # Full data URI — the format EmailJS's docs use (canvas.toDataURL()).
    import base64 as _b64
    assert sent[0]["chat_pdf"].startswith("data:application/pdf;base64,")
    assert _b64.b64decode(sent[0]["chat_pdf"].split(",", 1)[1]).startswith(b"%PDF")
    assert sent[0]["chat_pdf_name"] == "conversacion.pdf"


def test_email_media_html_inlines_images_and_links_the_rest():
    from routers import escalations
    with patch.object(escalations.settings, "public_origin", "https://s.mx"):
        html = escalations._email_media_html([
            {"file_name": "captura.png", "url": "/data/escalations/a_captura.png", "content_type": "image/png"},
            {"file_name": "clip.mp4", "url": "/data/escalations/b_clip.mp4", "content_type": "video/mp4"},
        ])
    # One inline image, one link, absolute URLs support can open from the inbox.
    assert html.count("<img") == 1 and "captura.png" in html
    assert "clip.mp4" in html  # video is a link, not an <img>
    assert "https://s.mx/api/media/stream/escalations/a_captura.png?exp=" in html
    assert "https://s.mx/api/media/stream/escalations/b_clip.mp4?exp=" in html


def test_email_media_html_skips_foreign_urls():
    from routers import escalations
    # A path we can't sign (not under /data/) is dropped, not rendered broken.
    assert escalations._email_media_html([{"file_name": "x", "url": "http://evil/x", "content_type": "image/png"}]) == ""


@pytest.mark.anyio
async def test_notify_passes_attachments_html():
    from routers import escalations
    sent = []
    with patch.object(escalations, "_send_via_emailjs", lambda p: sent.append(p) or True):
        await escalations._notify(_record_stub(), "hola", "", None, "<img src='x'>")
    # The media HTML rides in the `attachments` param — the template renders it
    # raw via {{{attachments}}}.
    assert sent[0]["attachments"] == "<img src='x'>"


@pytest.mark.anyio
async def test_notify_drops_a_pdf_over_the_plan_limit():
    # EmailJS rejects oversized requests outright — better to email without it.
    from routers import escalations
    sent = []
    with patch.object(escalations.settings, "emailjs_max_attach_kb", 1), \
         patch.object(escalations, "_send_via_emailjs", lambda p: sent.append(p) or True):
        await escalations._notify(_record_stub(), "hola", "", b"%PDF" + b"\x00" * 4096)
    assert "chat_pdf" not in sent[0] and sent[0]["conversation"] == "hola"


@pytest.mark.anyio
async def test_notify_retries_without_the_pdf_when_the_send_fails():
    from routers import escalations
    sent = []

    def _fail_first(params):
        sent.append(dict(params))
        return len(sent) > 1      # first attempt (with PDF) fails

    with patch.object(escalations, "_send_via_emailjs", _fail_first):
        await escalations._notify(_record_stub(), "hola", "", b"%PDF-1.7 fake")
    assert len(sent) == 2
    assert "chat_pdf" in sent[0] and "chat_pdf" not in sent[1]
    assert sent[1]["conversation"] == "hola"


# ── Attachment zip (the user's uploads bundled for the email) ──────────────────

def test_build_attachments_zip_bundles_what_fits():
    import io as _io
    import zipfile as _zip
    from routers import escalations
    media = [
        {"file_name": "a.png", "url": "/data/escalations/x_a.png", "size": 4},
        {"file_name": "b.csv", "url": "/data/escalations/y_b.csv", "size": 4},
    ]
    blobs = {"/data/escalations/x_a.png": b"AAAA", "/data/escalations/y_b.csv": b"BBBB"}
    with patch.object(escalations, "_read_local_bytes", lambda u: blobs.get(u)):
        zip_bytes, leftover = escalations._build_attachments_zip(media, 10_000)
    assert leftover == []
    assert set(_zip.ZipFile(_io.BytesIO(zip_bytes)).namelist()) == {"a.png", "b.csv"}


def test_build_attachments_zip_leaves_oversized_as_leftover():
    from routers import escalations
    small = {"file_name": "s.png", "url": "/data/escalations/s.png", "size": 5}
    big = {"file_name": "clip.mp4", "url": "/data/escalations/clip.mp4", "size": 5_000_000}
    # A large `size` skips the read entirely — we never pull the video into memory.
    with patch.object(escalations, "_read_local_bytes", lambda u: b"xxxxx"):
        zip_bytes, leftover = escalations._build_attachments_zip([big, small], 400)
    assert zip_bytes is not None and leftover == [big]


def test_build_attachments_zip_dedupes_colliding_names():
    import io as _io
    import zipfile as _zip
    from routers import escalations
    media = [
        {"file_name": "captura.png", "url": "/data/escalations/x_captura.png", "size": 4},
        {"file_name": "captura.png", "url": "/data/escalations/y_captura.png", "size": 4},
    ]
    with patch.object(escalations, "_read_local_bytes", lambda u: b"AAAA"):
        zip_bytes, leftover = escalations._build_attachments_zip(media, 10_000)
    names = _zip.ZipFile(_io.BytesIO(zip_bytes)).namelist()
    assert leftover == [] and len(names) == 2 and len(set(names)) == 2


@pytest.mark.anyio
async def test_notify_attaches_the_zip():
    import base64 as _b64
    from routers import escalations
    sent = []
    with patch.object(escalations, "_send_via_emailjs", lambda p: sent.append(p) or True):
        await escalations._notify(_record_stub(), "hola", "", None, "", b"PK\x03\x04zip")
    assert sent[0]["attachments_zip"].startswith("data:application/zip;base64,")
    assert _b64.b64decode(sent[0]["attachments_zip"].split(",", 1)[1]) == b"PK\x03\x04zip"
    assert sent[0]["attachments_zip_name"] == "adjuntos.zip"


@pytest.mark.anyio
async def test_notify_retries_without_the_zip_when_the_send_fails():
    from routers import escalations
    sent = []

    def _fail_first(params):
        sent.append(dict(params))
        return len(sent) > 1

    with patch.object(escalations, "_send_via_emailjs", _fail_first):
        await escalations._notify(_record_stub(), "hola", "", None, "", b"PKzip")
    assert len(sent) == 2
    assert "attachments_zip" in sent[0] and "attachments_zip" not in sent[1]


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
