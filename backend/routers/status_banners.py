"""Service-status banners: the public read every page polls, the admin CRUD
behind /admin/avisos, and the webhook an external monitor calls.

The self-monitor and the cache live in service_status.py; this module only
reads and writes rows, then invalidates that cache.
"""
import secrets
import uuid
from datetime import datetime, timedelta
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Header, HTTPException, Response
from pydantic import BaseModel, Field, StringConstraints, model_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

import service_status as status
from config import get_settings
from db.connection import get_db
from db.models import StatusBanner
from routers.admin import require_admin

settings = get_settings()

router = APIRouter(prefix="/api", tags=["status"])

Severity = Literal["info", "warning", "critical"]
Message = Annotated[str, StringConstraints(strip_whitespace=True, min_length=5, max_length=500)]
Contact = Annotated[str, StringConstraints(strip_whitespace=True, max_length=120)]
UpdateText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=3, max_length=500)]

_MAX_UPDATES = 50
_MAX_ETA_MINUTES = 7 * 24 * 60


def _check_times(starts_at: datetime, ends_at: datetime | None, eta_at: datetime | None) -> None:
    if ends_at is not None and ends_at <= starts_at:
        raise ValueError("La fecha de fin debe ser posterior al inicio")
    if eta_at is not None and eta_at <= starts_at:
        raise ValueError("El tiempo estimado de solución debe ser posterior al inicio")


# ── Schemas ───────────────────────────────────────────────────────────────────

class BannerCreate(BaseModel):
    message: Message
    severity: Severity = "warning"
    blocks_chat: bool = False
    contact: Contact | None = None
    starts_at: datetime | None = None   # omitted = publish now
    ends_at: datetime | None = None     # omitted = until an admin ends it
    eta_at: datetime | None = None      # estimated fix time shown to users

    @model_validator(mode="after")
    def _valid_times(self):
        _check_times(
            status.to_utc_naive(self.starts_at) or datetime.utcnow(),
            status.to_utc_naive(self.ends_at),
            status.to_utc_naive(self.eta_at),
        )
        return self


class BannerPatch(BaseModel):
    # Only fields present in the body change; send null to clear contact/ends_at/eta_at.
    message: Message | None = None
    severity: Severity | None = None
    blocks_chat: bool | None = None
    contact: Contact | None = None
    starts_at: datetime | None = None
    ends_at: datetime | None = None
    eta_at: datetime | None = None
    end_now: bool = False


class UpdateBody(BaseModel):
    text: UpdateText


class IncidentBody(BaseModel):
    """What an external monitor sends. `incident_key` is the monitor's own name
    for the problem; repeating an open alert refreshes the banner in place."""
    incident_key: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=80, pattern=r"^[A-Za-z0-9_.:\-]+$")]
    action: Literal["open", "resolve"]
    message: Message | None = None
    severity: Severity = "critical"
    blocks_chat: bool = True
    contact: Contact | None = None
    eta_minutes: int | None = Field(default=None, ge=1, le=_MAX_ETA_MINUTES)
    update: UpdateText | None = None

    @model_validator(mode="after")
    def _open_needs_message(self):
        if self.action == "open" and not self.message:
            raise ValueError("Para abrir un incidente se requiere un mensaje")
        return self


class SimulateBody(BaseModel):
    action: Literal["open", "resolve"]


# ── Helpers ───────────────────────────────────────────────────────────────────

def _parse_id(banner_id: str) -> uuid.UUID:
    try:
        return uuid.UUID(banner_id)
    except ValueError:
        raise HTTPException(status_code=422, detail="ID de aviso inválido")


async def _get_banner(db: AsyncSession, banner_id: str) -> StatusBanner:
    row = (await db.execute(
        select(StatusBanner).where(StatusBanner.id == _parse_id(banner_id))
    )).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Aviso no encontrado")
    return row


def _append_update(row: StatusBanner, text: str, at: datetime) -> None:
    # Reassign, don't mutate: SQLAlchemy doesn't track in-place JSONB changes.
    row.updates = [*(row.updates or []), {"at": status.iso(at), "text": text}]


async def _apply_incident(db: AsyncSession, body: IncidentBody, actor: str) -> dict:
    key = f"webhook:{body.incident_key}"
    row = (await db.execute(
        select(StatusBanner)
        .where(StatusBanner.incident_key == key, StatusBanner.ended_at.is_(None))
        .order_by(StatusBanner.created_at.desc())
        .limit(1)
    )).scalars().first()
    now = datetime.utcnow()
    title = f"Monitor externo · {body.incident_key}"

    if body.action == "resolve":
        if row is None:
            return {"state": "not_open"}   # idempotent: monitors retry
        row.ended_at = now
        row.updated_at = now
        if body.update:
            _append_update(row, body.update, now)
        await db.commit()
        status.invalidate()
        status.run_in_background(status.email_incident("resolve", title, row.message, body.update or "", row.starts_at))
        return {"state": "resolved", "id": str(row.id)}

    eta_at = now + timedelta(minutes=body.eta_minutes) if body.eta_minutes else None
    if row is None:
        row = StatusBanner(
            id=uuid.uuid4(), message=body.message, severity=body.severity, blocks_chat=body.blocks_chat,
            contact=body.contact or None, starts_at=now, eta_at=eta_at, updates=[], source="webhook",
            incident_key=key, created_by=actor, created_at=now, updated_at=now,
        )
        if body.update:
            _append_update(row, body.update, now)
        db.add(row)
        await db.commit()
        status.invalidate()
        status.run_in_background(status.email_incident("open", title, row.message, body.update or "", now))
        return {"state": "opened", "id": str(row.id)}

    # Already open: a repeated alert refreshes it. No second email.
    row.message, row.severity, row.blocks_chat = body.message, body.severity, body.blocks_chat
    if body.contact is not None:
        row.contact = body.contact or None
    if eta_at is not None:
        row.eta_at = eta_at
    last = (row.updates or [])[-1:]
    if body.update and (not last or last[0].get("text") != body.update):
        _append_update(row, body.update, now)
    row.updated_at = now
    await db.commit()
    status.invalidate()
    return {"state": "updated", "id": str(row.id)}


def _require_webhook_key(x_status_key: str | None = Header(default=None)) -> None:
    if not settings.status_webhook_key:
        # Disabled: answer like an unknown route rather than advertising it.
        raise HTTPException(status_code=404, detail="Not Found")
    if not x_status_key or not secrets.compare_digest(
        x_status_key.encode(), settings.status_webhook_key.encode()
    ):
        raise HTTPException(status_code=401, detail="Clave de monitoreo inválida")


# ── Public ────────────────────────────────────────────────────────────────────

@router.get("/status")
async def get_public_status(response: Response):
    """No auth: the login page shows banners too. Never touches the request's DB
    session — see service_status for why it must keep answering without one."""
    response.headers["Cache-Control"] = "no-store"
    return await status.public_status()


@router.post("/status/incidents")
async def report_incident(
    body: IncidentBody,
    db: AsyncSession = Depends(get_db),
    _: None = Depends(_require_webhook_key),
):
    """Webhook for an external monitor. Authenticated by the shared
    X-Status-Key header (STATUS_WEBHOOK_KEY), not a user token."""
    return await _apply_incident(db, body, actor="webhook")


# ── Admin ─────────────────────────────────────────────────────────────────────

@router.get("/admin/banners")
async def list_banners(
    db: AsyncSession = Depends(get_db),
    _: dict = Depends(require_admin),
):
    now = datetime.utcnow()
    rows = (await db.execute(
        select(StatusBanner).order_by(StatusBanner.starts_at.desc()).limit(200)
    )).scalars().all()
    active, scheduled, past = [], [], []
    for r in rows:
        if r.ended_at is not None or (r.ends_at is not None and r.ends_at <= now):
            past.append(r)
        elif r.starts_at > now:
            scheduled.append(r)
        else:
            active.append(r)
    scheduled.sort(key=lambda r: r.starts_at)   # soonest first
    return {
        "active": [status.serialize(r) for r in active],
        "scheduled": [status.serialize(r) for r in scheduled],
        "past": [status.serialize(r) for r in past[:50]],
    }


@router.post("/admin/banners", status_code=201)
async def create_banner(
    body: BannerCreate,
    db: AsyncSession = Depends(get_db),
    admin: dict = Depends(require_admin),
):
    now = datetime.utcnow()
    banner = StatusBanner(
        id=uuid.uuid4(),
        message=body.message,
        severity=body.severity,
        blocks_chat=body.blocks_chat,
        contact=body.contact or None,
        starts_at=status.to_utc_naive(body.starts_at) or now,
        ends_at=status.to_utc_naive(body.ends_at),
        eta_at=status.to_utc_naive(body.eta_at),
        updates=[],
        source="manual",
        created_by=admin.get("email") or admin.get("uid"),
        created_at=now,
        updated_at=now,
    )
    db.add(banner)
    await db.commit()
    status.invalidate()
    return status.serialize(banner)


@router.patch("/admin/banners/{banner_id}")
async def update_banner(
    banner_id: str,
    body: BannerPatch,
    db: AsyncSession = Depends(get_db),
    _: dict = Depends(require_admin),
):
    row = await _get_banner(db, banner_id)
    sent = body.model_fields_set
    if body.message is not None:
        row.message = body.message
    if body.severity is not None:
        row.severity = body.severity
    if body.blocks_chat is not None:
        row.blocks_chat = body.blocks_chat
    if "contact" in sent:
        row.contact = body.contact or None
    if body.starts_at is not None:
        row.starts_at = status.to_utc_naive(body.starts_at)
    if "ends_at" in sent:
        row.ends_at = status.to_utc_naive(body.ends_at)
    if "eta_at" in sent:
        row.eta_at = status.to_utc_naive(body.eta_at)
    try:
        _check_times(row.starts_at, row.ends_at, row.eta_at)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    now = datetime.utcnow()
    if body.end_now and row.ended_at is None:
        row.ended_at = now
    row.updated_at = now
    await db.commit()
    status.invalidate()
    return status.serialize(row)


@router.post("/admin/banners/{banner_id}/updates", status_code=201)
async def add_banner_update(
    banner_id: str,
    body: UpdateBody,
    db: AsyncSession = Depends(get_db),
    _: dict = Depends(require_admin),
):
    row = await _get_banner(db, banner_id)
    if len(row.updates or []) >= _MAX_UPDATES:
        raise HTTPException(status_code=422, detail="Este aviso alcanzó el máximo de actualizaciones")
    now = datetime.utcnow()
    _append_update(row, body.text, now)
    row.updated_at = now
    await db.commit()
    status.invalidate()
    return status.serialize(row)


@router.delete("/admin/banners/{banner_id}", status_code=204)
async def delete_banner(
    banner_id: str,
    db: AsyncSession = Depends(get_db),
    _: dict = Depends(require_admin),
):
    row = await _get_banner(db, banner_id)
    await db.delete(row)
    await db.commit()
    status.invalidate()
    return Response(status_code=204)


@router.get("/admin/status/checks")
async def status_checks(_: dict = Depends(require_admin)):
    return status.checks_snapshot()


_SIMULATED_KEY = "simulacion"
_SIMULATED_MESSAGE = (
    "Detectamos una falla en el servicio. Encontramos el error y ya trabajamos en "
    "ello; mientras tanto, puede comunicarse con el equipo de soporte."
)


@router.post("/admin/status/simulate")
async def simulate_incident(
    body: SimulateBody,
    db: AsyncSession = Depends(get_db),
    admin: dict = Depends(require_admin),
):
    """Demo stand-in for an external monitor: the same code path a real
    POST /api/status/incidents runs, authorized by the admin's session instead
    of the shared key (which the browser must never hold)."""
    opening = body.action == "open"
    incident = IncidentBody(
        incident_key=_SIMULATED_KEY,
        action=body.action,
        message=_SIMULATED_MESSAGE if opening else None,
        eta_minutes=60 if opening else None,
        update=None if opening else "Simulación finalizada: el servicio se restableció.",
    )
    return await _apply_incident(db, incident, actor=admin.get("email") or "admin")
