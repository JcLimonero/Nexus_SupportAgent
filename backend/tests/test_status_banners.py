import asyncio
import time
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import jwt as PyJWT
import pytest

import service_status
from config import get_settings
from db.models import StatusBanner
from tests.conftest import make_db_override, make_jwt, _jwt_secret


# ── Helpers ───────────────────────────────────────────────────────────────────

def _admin():
    return {"Authorization": f"Bearer {make_jwt(email='admin@nexus.local', is_admin=True)}"}


def _user():
    return {"Authorization": f"Bearer {make_jwt()}"}


def _guest():
    token = PyJWT.encode({
        "uid": f"anon:{uuid.uuid4().hex}", "email": "Invitado #ab12", "is_admin": False, "is_anon": True,
        "exp": datetime.now(timezone.utc) + timedelta(hours=1),
    }, _jwt_secret(), algorithm="HS256")
    return {"Authorization": f"Bearer {token}"}


def _banner(**overrides) -> StatusBanner:
    now = datetime.utcnow()
    fields = dict(
        id=uuid.uuid4(), message="Mantenimiento programado del sistema", severity="warning",
        blocks_chat=False, contact=None, starts_at=now - timedelta(minutes=5), ends_at=None,
        eta_at=None, ended_at=None, updates=[], source="manual", incident_key=None,
        created_by="admin@nexus.local", created_at=now, updated_at=now,
    )
    fields.update(overrides)
    return StatusBanner(**fields)


def _use_row(row):
    """Point the request's DB session at one row (None = not found)."""
    from db.connection import get_db
    from main import app
    app.dependency_overrides[get_db] = make_db_override(row)


def _use_rows(rows):
    from db.connection import get_db
    from main import app

    async def _override():
        session = AsyncMock()
        result = MagicMock()
        result.scalars.return_value.all.return_value = rows
        session.execute = AsyncMock(return_value=result)
        yield session
    app.dependency_overrides[get_db] = _override


def _loaded(*banners, ends=None):
    return AsyncMock(return_value=[(service_status.serialize(b), ends) for b in banners])


def _create(**overrides):
    body = {"message": "Mantenimiento del sistema esta noche", "severity": "warning"}
    body.update(overrides)
    return body


def _iso(dt: datetime) -> str:
    return dt.isoformat() + "Z"


async def _noop():
    return None


@pytest.fixture(autouse=True)
def _clean_status():
    settings = get_settings()
    saved = (settings.status_webhook_key, settings.emailjs_status_template_id,
             settings.emailjs_service_id, settings.emailjs_public_key)
    service_status.reset_state()
    yield
    (settings.status_webhook_key, settings.emailjs_status_template_id,
     settings.emailjs_service_id, settings.emailjs_public_key) = saved
    service_status.reset_state()


@pytest.fixture
def emails():
    """Records which incident emails would go out, without sending any."""
    sent: list[str] = []

    def _fake(kind, title, message, detail, started_at):
        sent.append(kind)
        return _noop()

    with patch.object(service_status, "email_incident", _fake):
        yield sent


# ── Public endpoint ───────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_public_status_needs_no_auth_and_is_ok_when_quiet(client):
    with patch.object(service_status, "_load_active_banners", AsyncMock(return_value=[])):
        response = await client.get("/api/status")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    body = response.json()
    assert body["state"] == "ok" and body["chat_blocked"] is False and body["banners"] == []


@pytest.mark.anyio
async def test_public_status_shows_live_banner_and_blocks_chat(client):
    banner = _banner(severity="critical", blocks_chat=True, contact="45454545")
    with patch.object(service_status, "_load_active_banners", _loaded(banner)):
        body = (await client.get("/api/status")).json()
    assert body["state"] == "down" and body["chat_blocked"] is True
    [shown] = body["banners"]
    assert shown["contact"] == "45454545"
    assert shown["starts_at"].endswith("Z")   # browsers must parse it as UTC
    # Bookkeeping stays admin-only.
    assert "created_by" not in shown and "incident_key" not in shown


@pytest.mark.anyio
async def test_public_status_puts_critical_first(client):
    older_critical = _banner(severity="critical", starts_at=datetime.utcnow() - timedelta(hours=2))
    newer_warning = _banner(severity="warning")
    with patch.object(service_status, "_load_active_banners", _loaded(newer_warning, older_critical)):
        body = (await client.get("/api/status")).json()
    assert [b["severity"] for b in body["banners"]] == ["critical", "warning"]


@pytest.mark.anyio
async def test_public_status_keeps_the_last_banners_when_the_db_fails(client):
    with patch.object(service_status, "_load_active_banners", _loaded(_banner())):
        assert len((await client.get("/api/status")).json()["banners"]) == 1
    service_status.invalidate()
    with patch.object(service_status, "_load_active_banners", AsyncMock(side_effect=OSError("db down"))):
        response = await client.get("/api/status")
    assert response.status_code == 200
    assert len(response.json()["banners"]) == 1


@pytest.mark.anyio
async def test_a_poll_during_a_refresh_waits_for_it_instead_of_serving_stale():
    """Regression: two tabs polling together right after an admin published —
    the second used to get the pre-publish (empty) list while the first read."""
    started, release = asyncio.Event(), asyncio.Event()
    banner = _banner()

    async def slow_load():
        started.set()
        await release.wait()
        return [(service_status.serialize(banner), None)]

    with patch.object(service_status, "_load_active_banners", slow_load):
        first = asyncio.create_task(service_status.public_status())
        await started.wait()
        second = asyncio.create_task(service_status.public_status())
        await asyncio.sleep(0)
        release.set()
        results = await asyncio.gather(first, second)
    assert [len(r["banners"]) for r in results] == [1, 1]


@pytest.mark.anyio
async def test_a_write_during_a_refresh_is_not_hidden_for_the_ttl():
    banner = _banner()
    calls = []

    async def load():
        calls.append(1)
        if len(calls) == 1:
            service_status.invalidate()   # an admin write lands while this read is in flight
            return []
        return [(service_status.serialize(banner), None)]

    with patch.object(service_status, "_load_active_banners", load):
        assert (await service_status.public_status())["banners"] == []
        assert len((await service_status.public_status())["banners"]) == 1


@pytest.mark.anyio
async def test_public_status_drops_a_cached_banner_past_its_end(client):
    loader = _loaded(_banner(), ends=datetime.utcnow() - timedelta(seconds=1))
    with patch.object(service_status, "_load_active_banners", loader):
        assert (await client.get("/api/status")).json()["banners"] == []


# ── Self-monitor ──────────────────────────────────────────────────────────────

async def _skip():
    raise service_status._Skipped("n/a")


async def _disk_ok():
    return "OK"


@pytest.mark.anyio
async def test_monitor_opens_after_the_threshold_and_clears_after_recovery(emails):
    db_ok = {"value": False}

    async def db_check():
        if not db_ok["value"]:
            raise RuntimeError("connection refused")
        return "Conectada"

    persist, close = AsyncMock(), AsyncMock()
    funcs = {"db": db_check, "llm": _skip, "disk": _disk_ok}
    with patch.dict(service_status._CHECK_FUNCS, funcs), \
         patch.object(service_status, "_persist", persist), \
         patch.object(service_status, "_persist_close", close):
        chk = service_status._checks["db"]
        for _ in range(2):
            await service_status.run_checks_once()
        assert not chk.down and persist.await_count == 0   # two blips don't open an outage

        await service_status.run_checks_once()
        assert chk.down and chk.incident and persist.await_count == 1
        assert chk.detail == "connection refused"

        db_ok["value"] = True
        await service_status.run_checks_once()
        assert chk.down                                     # one good check isn't recovery

        await service_status.run_checks_once()
        assert not chk.down and chk.incident is None and close.await_count == 1
    assert emails == ["open", "resolve"]


@pytest.mark.anyio
async def test_monitor_incident_is_served_from_memory_when_the_db_is_down(emails):
    async def db_down():
        raise asyncio.TimeoutError()

    funcs = {"db": db_down, "llm": _skip, "disk": _disk_ok}
    with patch.dict(service_status._CHECK_FUNCS, funcs), \
         patch.object(service_status, "_persist", AsyncMock(side_effect=OSError("db down"))), \
         patch.object(service_status, "_load_active_banners", AsyncMock(side_effect=OSError("db down"))):
        for _ in range(3):
            await service_status.run_checks_once()
        body = await service_status.public_status()
    assert body["state"] == "down" and body["chat_blocked"] is True
    assert "problemas técnicos" in body["banners"][0]["message"]
    assert service_status._checks["db"].detail.startswith("Sin respuesta")


@pytest.mark.anyio
async def test_a_persisted_monitor_incident_defers_to_the_db(emails):
    """Once written, the row is the truth — an admin who ended it early must
    not see it pop back from the monitor's memory."""
    async def db_down():
        raise RuntimeError("boom")

    funcs = {"db": db_down, "llm": _skip, "disk": _disk_ok}
    with patch.dict(service_status._CHECK_FUNCS, funcs), \
         patch.object(service_status, "_persist", AsyncMock()), \
         patch.object(service_status, "_load_active_banners", AsyncMock(return_value=[])):
        for _ in range(3):
            await service_status.run_checks_once()
        body = await service_status.public_status()
    assert body["banners"] == []


@pytest.mark.anyio
async def test_disk_trouble_never_opens_a_user_banner(emails):
    async def disk_low():
        raise RuntimeError("Solo 12 MB libres")

    funcs = {"db": _disk_ok, "llm": _skip, "disk": disk_low}
    with patch.dict(service_status._CHECK_FUNCS, funcs), patch.object(service_status, "_persist", AsyncMock()):
        for _ in range(5):
            await service_status.run_checks_once()
    assert service_status._checks["disk"].ok is False and not service_status._checks["disk"].down
    assert emails == []


@pytest.mark.anyio
async def test_a_restart_mid_outage_restores_the_open_incident():
    row = _banner(source="monitor", incident_key="monitor:llm", severity="critical", blocks_chat=True)
    session = AsyncMock()
    result = MagicMock()
    result.scalars.return_value.all.return_value = [row]
    session.execute = AsyncMock(return_value=result)
    ctx = MagicMock()
    ctx.__aenter__ = AsyncMock(return_value=session)
    ctx.__aexit__ = AsyncMock(return_value=False)
    with patch.object(service_status.dbc, "AsyncSessionLocal", MagicMock(return_value=ctx)):
        await service_status.restore_open_incidents()
    chk = service_status._checks["llm"]
    assert chk.down and chk.persisted and chk.incident["id"] == str(row.id)


def test_llm_failing_needs_repeated_failures_with_no_later_success():
    record = service_status.record_llm_result
    record(False)
    record(False)
    assert not service_status.llm_failing()
    record(False)
    assert service_status.llm_failing()
    record(True)
    assert not service_status.llm_failing()


def test_llm_failures_age_out_of_the_window():
    for _ in range(3):
        service_status.record_llm_result(False)
    later = time.monotonic() + get_settings().status_llm_error_window_s + 1
    assert not service_status.llm_failing(now=later)


@pytest.mark.anyio
async def test_status_email_is_skipped_without_its_template():
    settings = get_settings()
    settings.emailjs_service_id, settings.emailjs_public_key = "svc", "pub"
    settings.emailjs_status_template_id = ""   # the escalation template must not be reused
    with patch("routers.escalations._send_via_emailjs") as send:
        await service_status.email_incident("open", "Base de datos", "msg", "detalle", datetime.utcnow())
    send.assert_not_called()


@pytest.mark.anyio
async def test_status_email_uses_its_own_template():
    settings = get_settings()
    settings.emailjs_service_id, settings.emailjs_public_key = "svc", "pub"
    settings.emailjs_status_template_id = "tpl_status"
    with patch("routers.escalations._send_via_emailjs", return_value=True) as send:
        await service_status.email_incident("resolve", "Base de datos", "msg", "", datetime.utcnow())
    params, timeout, template_id = send.call_args.args
    assert template_id == "tpl_status"
    assert params["status"] == "Restablecido" and params["resolved_at"]


# ── Admin: auth ───────────────────────────────────────────────────────────────

_BID = str(uuid.uuid4())
_ADMIN_ROUTES = [
    ("GET", "/api/admin/banners", None),
    ("POST", "/api/admin/banners", _create()),
    ("PATCH", f"/api/admin/banners/{_BID}", {"end_now": True}),
    ("POST", f"/api/admin/banners/{_BID}/updates", {"text": "Seguimos trabajando"}),
    ("DELETE", f"/api/admin/banners/{_BID}", None),
    ("GET", "/api/admin/status/checks", None),
    ("POST", "/api/admin/status/simulate", {"action": "open"}),
]


@pytest.mark.anyio
@pytest.mark.parametrize("method,url,body", _ADMIN_ROUTES)
async def test_admin_status_routes_require_auth(client, method, url, body):
    response = await client.request(method, url, json=body)
    assert response.status_code == 401


@pytest.mark.anyio
@pytest.mark.parametrize("method,url,body", _ADMIN_ROUTES)
async def test_admin_status_routes_reject_users_and_guests(client, method, url, body):
    for headers in (_user(), _guest()):
        response = await client.request(method, url, json=body, headers=headers)
        assert response.status_code == 403


# ── Admin: create / list ──────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_admin_creates_a_banner(client):
    response = await client.post(
        "/api/admin/banners", headers=_admin(),
        json=_create(severity="critical", blocks_chat=True, contact=" 45454545 "),
    )
    assert response.status_code == 201
    body = response.json()
    assert body["source"] == "manual" and body["blocks_chat"] is True
    assert body["contact"] == "45454545" and body["updates"] == []
    assert body["created_by"] == "admin@nexus.local" and body["starts_at"].endswith("Z")


@pytest.mark.anyio
async def test_admin_schedules_with_timezone_aware_times(client):
    start = datetime(2030, 1, 1, 15, 0, tzinfo=timezone(timedelta(hours=-6)))
    response = await client.post(
        "/api/admin/banners", headers=_admin(),
        json=_create(
            starts_at=start.isoformat(),
            eta_at=(start + timedelta(hours=1)).isoformat(),
            ends_at=(start + timedelta(hours=2)).isoformat(),
        ),
    )
    assert response.status_code == 201
    body = response.json()
    assert body["starts_at"] == "2030-01-01T21:00:00Z"
    assert body["eta_at"] == "2030-01-01T22:00:00Z"
    assert body["ends_at"] == "2030-01-01T23:00:00Z"


@pytest.mark.anyio
@pytest.mark.parametrize("override", [
    {"message": ""},
    {"message": "hola"},
    {"message": "x" * 501},
    {"severity": "urgent"},
    {"contact": "x" * 121},
    {"ends_at": _iso(datetime.utcnow() - timedelta(hours=1))},
    {"starts_at": "2030-01-01T10:00:00Z", "ends_at": "2030-01-01T09:00:00Z"},
    {"starts_at": "2030-01-01T10:00:00Z", "eta_at": "2030-01-01T10:00:00Z"},
])
async def test_create_validation(client, override):
    response = await client.post("/api/admin/banners", headers=_admin(), json=_create(**override))
    assert response.status_code == 422


@pytest.mark.anyio
async def test_admin_list_splits_active_scheduled_and_past(client):
    now = datetime.utcnow()
    _use_rows([
        _banner(message="activo"),
        _banner(message="programado", starts_at=now + timedelta(days=1)),
        _banner(message="finalizado", ended_at=now - timedelta(minutes=1)),
        _banner(message="vencido", ends_at=now - timedelta(minutes=1)),
    ])
    response = await client.get("/api/admin/banners", headers=_admin())
    assert response.status_code == 200
    body = response.json()
    assert [b["message"] for b in body["active"]] == ["activo"]
    assert [b["message"] for b in body["scheduled"]] == ["programado"]
    assert sorted(b["message"] for b in body["past"]) == ["finalizado", "vencido"]


# ── Admin: edit / updates / delete ────────────────────────────────────────────

@pytest.mark.anyio
async def test_patch_unknown_banner_404(client):
    response = await client.patch(f"/api/admin/banners/{uuid.uuid4()}", headers=_admin(), json={"end_now": True})
    assert response.status_code == 404


@pytest.mark.anyio
async def test_patch_invalid_id_422(client):
    response = await client.patch("/api/admin/banners/not-a-uuid", headers=_admin(), json={"end_now": True})
    assert response.status_code == 422


@pytest.mark.anyio
async def test_admin_ends_a_banner_now(client):
    row = _banner()
    _use_row(row)
    response = await client.patch(f"/api/admin/banners/{row.id}", headers=_admin(), json={"end_now": True})
    assert response.status_code == 200
    assert response.json()["ended_at"] is not None and row.ended_at is not None


@pytest.mark.anyio
async def test_patch_edits_and_clears_fields(client):
    row = _banner(contact="123456789", eta_at=datetime.utcnow() + timedelta(hours=1))
    _use_row(row)
    response = await client.patch(
        f"/api/admin/banners/{row.id}", headers=_admin(),
        json={"message": "Nuevo texto del aviso", "severity": "critical", "contact": None, "eta_at": None},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["message"] == "Nuevo texto del aviso" and body["severity"] == "critical"
    assert body["contact"] is None and body["eta_at"] is None
    assert body["blocks_chat"] is False   # untouched fields stay as they were


@pytest.mark.anyio
async def test_patch_rejects_an_end_before_the_start(client):
    row = _banner()
    _use_row(row)
    response = await client.patch(
        f"/api/admin/banners/{row.id}", headers=_admin(),
        json={"ends_at": _iso(row.starts_at - timedelta(hours=1))},
    )
    assert response.status_code == 422


@pytest.mark.anyio
async def test_admin_posts_an_update(client):
    row = _banner()
    _use_row(row)
    response = await client.post(
        f"/api/admin/banners/{row.id}/updates", headers=_admin(),
        json={"text": "Encontramos el error y trabajamos en ello"},
    )
    assert response.status_code == 201
    [update] = response.json()["updates"]
    assert update["text"] == "Encontramos el error y trabajamos en ello" and update["at"].endswith("Z")


@pytest.mark.anyio
async def test_update_validation_not_found_and_cap(client):
    row = _banner()
    _use_row(row)
    assert (await client.post(f"/api/admin/banners/{row.id}/updates", headers=_admin(), json={"text": "ok"})).status_code == 422
    full = _banner(updates=[{"at": "2026-01-01T00:00:00Z", "text": "x"}] * 50)
    _use_row(full)
    assert (await client.post(f"/api/admin/banners/{full.id}/updates", headers=_admin(), json={"text": "Una más"})).status_code == 422
    _use_row(None)
    assert (await client.post(f"/api/admin/banners/{uuid.uuid4()}/updates", headers=_admin(), json={"text": "Seguimos"})).status_code == 404


@pytest.mark.anyio
async def test_admin_deletes_a_banner(client):
    row = _banner()
    _use_row(row)
    assert (await client.delete(f"/api/admin/banners/{row.id}", headers=_admin())).status_code == 204
    _use_row(None)
    assert (await client.delete(f"/api/admin/banners/{uuid.uuid4()}", headers=_admin())).status_code == 404


@pytest.mark.anyio
async def test_admin_sees_the_monitor_checks(client):
    response = await client.get("/api/admin/status/checks", headers=_admin())
    assert response.status_code == 200
    body = response.json()
    assert {c["key"] for c in body["checks"]} == {"db", "llm", "disk"}
    assert "webhook_enabled" in body and "email_enabled" in body


# ── External monitor webhook ──────────────────────────────────────────────────

_OPEN = {"incident_key": "erp-api", "action": "open", "message": "El ERP no responde en este momento"}


@pytest.mark.anyio
async def test_webhook_is_hidden_when_no_key_is_configured(client):
    get_settings().status_webhook_key = ""
    response = await client.post("/api/status/incidents", json=_OPEN, headers={"X-Status-Key": "anything"})
    assert response.status_code == 404


@pytest.mark.anyio
async def test_webhook_rejects_a_missing_or_wrong_key(client):
    get_settings().status_webhook_key = "s3cret"
    assert (await client.post("/api/status/incidents", json=_OPEN)).status_code == 401
    assert (await client.post("/api/status/incidents", json=_OPEN, headers={"X-Status-Key": "nope"})).status_code == 401
    # A user token is not a monitor key.
    assert (await client.post("/api/status/incidents", json=_OPEN, headers=_admin())).status_code == 401


@pytest.mark.anyio
@pytest.mark.parametrize("body", [
    {"incident_key": "erp-api", "action": "open"},                             # open needs a message
    {**_OPEN, "incident_key": "bad key!"},
    {**_OPEN, "action": "explode"},
    {**_OPEN, "eta_minutes": 0},
    {**_OPEN, "severity": "urgent"},
])
async def test_webhook_validation(client, body):
    get_settings().status_webhook_key = "s3cret"
    response = await client.post("/api/status/incidents", json=body, headers={"X-Status-Key": "s3cret"})
    assert response.status_code == 422


@pytest.mark.anyio
async def test_webhook_opens_an_incident_and_emails(client, emails):
    get_settings().status_webhook_key = "s3cret"
    response = await client.post(
        "/api/status/incidents", headers={"X-Status-Key": "s3cret"},
        json={**_OPEN, "eta_minutes": 30, "update": "Investigando la causa"},
    )
    assert response.status_code == 200 and response.json()["state"] == "opened"
    assert emails == ["open"]


@pytest.mark.anyio
async def test_a_repeated_alert_updates_in_place_without_another_email(client, emails):
    get_settings().status_webhook_key = "s3cret"
    row = _banner(source="webhook", incident_key="webhook:erp-api", severity="critical", blocks_chat=True)
    _use_row(row)
    body = {**_OPEN, "message": "El ERP sigue sin responder", "update": "Seguimos trabajando"}
    for _ in range(2):   # the identical update is not stacked twice
        response = await client.post("/api/status/incidents", headers={"X-Status-Key": "s3cret"}, json=body)
        assert response.status_code == 200 and response.json()["state"] == "updated"
    assert row.message == "El ERP sigue sin responder"
    assert [u["text"] for u in row.updates] == ["Seguimos trabajando"]
    assert emails == []


@pytest.mark.anyio
async def test_webhook_resolves_and_is_idempotent(client, emails):
    get_settings().status_webhook_key = "s3cret"
    row = _banner(source="webhook", incident_key="webhook:erp-api")
    _use_row(row)
    resolve = {"incident_key": "erp-api", "action": "resolve"}
    response = await client.post("/api/status/incidents", headers={"X-Status-Key": "s3cret"}, json=resolve)
    assert response.json()["state"] == "resolved" and row.ended_at is not None
    assert emails == ["resolve"]

    _use_row(None)
    response = await client.post("/api/status/incidents", headers={"X-Status-Key": "s3cret"}, json=resolve)
    assert response.status_code == 200 and response.json()["state"] == "not_open"


@pytest.mark.anyio
async def test_simulated_monitor_runs_the_webhook_path_without_the_key(client, emails):
    get_settings().status_webhook_key = ""   # the demo works even with the webhook disabled
    response = await client.post("/api/admin/status/simulate", headers=_admin(), json={"action": "open"})
    assert response.status_code == 200 and response.json()["state"] == "opened"
    assert emails == ["open"]
    bad = await client.post("/api/admin/status/simulate", headers=_admin(), json={"action": "explode"})
    assert bad.status_code == 422
