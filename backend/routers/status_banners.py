"""Service-status banners: the public read every page polls, the admin CRUD
behind /admin/avisos. Rows come from admins and from the self-monitor.

The self-monitor and the cache live in service_status.py; this module only
reads and writes rows, then invalidates that cache — and tells the monitor to
let go of an incident an admin ended or deleted (status.forget_incident).
"""
import uuid
from datetime import datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, StringConstraints, model_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

import service_status as status
from db.connection import get_db
from db.models import StatusBanner
from routers.admin import require_admin

router = APIRouter(prefix="/api", tags=["status"])

Severity = Literal["info", "warning", "critical"]
Message = Annotated[str, StringConstraints(strip_whitespace=True, min_length=5, max_length=500)]
Contact = Annotated[str, StringConstraints(strip_whitespace=True, max_length=120)]
UpdateText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=3, max_length=500)]

_MAX_UPDATES = 50


def _check_times(starts_at: datetime, ends_at: datetime | None, eta_at: datetime | None) -> None:
    if ends_at is not None and ends_at <= starts_at:
        raise ValueError("La fecha de fin debe ser posterior al inicio")
    if eta_at is not None and eta_at <= starts_at:
        raise ValueError("El tiempo estimado de solución debe ser posterior al inicio")
    if eta_at is not None and ends_at is not None and eta_at > ends_at:
        raise ValueError("El tiempo estimado de solución no puede ser posterior al fin del aviso")


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
    # Capped here too, not just in add_banner_update's pre-check, so no
    # caller can grow the list without bound.
    updates = [*(row.updates or []), {"at": status.iso(at), "text": text}]
    row.updates = updates[-_MAX_UPDATES:]


# ── Public ────────────────────────────────────────────────────────────────────

@router.get("/status")
async def get_public_status(response: Response):
    """No auth: the login page shows banners too. Never touches the request's DB
    session — see service_status for why it must keep answering without one."""
    response.headers["Cache-Control"] = "no-store"
    return await status.public_status()


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
    # A monitor banner that is no longer live — ended by hand, or given an
    # ends_at that has already passed — has to be dropped from the monitor's
    # memory too, or it reappears on the next DB hiccup and its check can never
    # open another one. Still failing? It raises a fresh incident, by design.
    if row.ended_at is not None or (row.ends_at is not None and row.ends_at <= now):
        status.forget_incident(str(row.id))
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
    deleted_id = str(row.id)
    await db.delete(row)
    await db.commit()
    status.forget_incident(deleted_id)   # same reason as the end_now path above
    status.invalidate()
    return Response(status_code=204)


@router.get("/admin/status/checks")
async def status_checks(_: dict = Depends(require_admin)):
    return status.checks_snapshot()
