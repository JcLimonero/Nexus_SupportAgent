import asyncio
import json
import logging
import shutil
import tempfile
import urllib.request
import uuid
from datetime import datetime, timedelta
from pathlib import Path

import filetype
from fastapi import APIRouter, BackgroundTasks, Depends, File, HTTPException, UploadFile
from typing import Annotated

from pydantic import BaseModel, Field, StringConstraints
from sqlalchemy import select, update as sql_update, func
from sqlalchemy.ext.asyncio import AsyncSession

from db.connection import get_db, AsyncSessionLocal
from db.models import EscalationRequest
from auth.firebase_verify import get_current_user
from routers.admin import require_admin, save_file, _safe_filename, _looks_like_text
from config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()

router = APIRouter(prefix="/api", tags=["escalations"])

_STATUSES = ("new", "in_progress", "resolved")


async def require_account(user: dict = Depends(get_current_user)) -> dict:
    """Support requests are for real accounts only. A guest leaves no reliable
    way to follow up and is trivially re-created, so the inbox stays signed-in."""
    if user.get("is_anon"):
        raise HTTPException(status_code=403, detail="Inicia sesión para solicitar ayuda")
    return user

# ── Attachment limits (user/guest uploads — tighter than the admin KB upload) ──
_ATTACH_MAX_BYTES = 5 * 1024 * 1024    # 5 MB per file
_ATTACH_MAX_COUNT = 10
_ATTACH_URL_PREFIX = "/data/escalations/"
# Broader than the KB allowlist: images (to recreate the problem), video, docs.
_ATTACH_TEXT_EXT = {".txt", ".csv"}
_ATTACH_BINARY_EXT = {
    ".png", ".jpg", ".jpeg", ".gif", ".webp",   # images
    ".mp4", ".webm", ".mov",                     # video
    ".pdf", ".docx", ".xlsx",                    # docs
}
_ATTACH_ALLOWED_EXT = _ATTACH_TEXT_EXT | _ATTACH_BINARY_EXT
# filetype's detected extension must land in this set (spoof guard). jpg==jpeg.
_ATTACH_DETECTED = {"png", "jpg", "gif", "webp", "mp4", "mov", "webm", "pdf", "docx", "xlsx"}


# ── Email notification via EmailJS (best-effort) ──────────────────────────────

_EMAILJS_URL = "https://api.emailjs.com/api/v1.0/email/send"


def _send_via_emailjs(template_params: dict) -> None:
    """Blocking server-side POST to EmailJS. No-op if not configured. Never
    raises — the escalation is already saved; email is a bonus, not a guarantee."""
    if not (settings.emailjs_service_id and settings.emailjs_template_id and settings.emailjs_public_key):
        logger.info("EmailJS not configured — escalation email skipped")
        return
    payload = {
        "service_id": settings.emailjs_service_id,
        "template_id": settings.emailjs_template_id,
        "user_id": settings.emailjs_public_key,
        "template_params": template_params,
    }
    if settings.emailjs_private_key:
        payload["accessToken"] = settings.emailjs_private_key  # strict / server-side mode
    try:
        req = urllib.request.Request(
            _EMAILJS_URL,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            resp.read()
    except Exception as exc:
        logger.error("EmailJS send failed: %s", exc)


async def _notify(record: EscalationRequest) -> None:
    who = record.name or record.user_label or record.user_id
    attach_names = ", ".join(a.get("file_name", "?") for a in (record.attachments or [])) or "—"
    link = ""
    if record.session_id and settings.public_origin:
        link = f"{settings.public_origin}/admin/conversations?id={record.session_id}"
    # Keys map to variables in the EmailJS template the user creates.
    params = {
        "subject": f"Nueva solicitud de soporte — {who}",
        "from_name": who,
        "contact": record.contact,
        "reason": record.reason or "(sin especificar)",
        "attachments": attach_names,
        "conversation_link": link,
        "to_email": settings.escalation_notify_email,
    }
    await asyncio.to_thread(_send_via_emailjs, params)


# ── Schemas ───────────────────────────────────────────────────────────────────

class Attachment(BaseModel):
    file_name: str = Field(min_length=1, max_length=255)
    url: str = Field(min_length=1, max_length=500)
    content_type: str | None = Field(default=None, max_length=120)
    size: int | None = None


class EscalationRequestBody(BaseModel):
    contact: str = Field(min_length=3, max_length=120)
    name: str | None = Field(default=None, max_length=80)
    # Required: a ticket with no description is one support has to chase down.
    # Stripped first so whitespace can't pass for a description.
    reason: Annotated[str, StringConstraints(strip_whitespace=True, min_length=10, max_length=1000)]
    session_id: str | None = None
    attachments: list[Attachment] = Field(default_factory=list, max_length=_ATTACH_MAX_COUNT)


class StatusUpdate(BaseModel):
    status: str = Field(pattern="^(new|in_progress|resolved)$")


# ── Routes ────────────────────────────────────────────────────────────────────

@router.post("/escalations/attachments", status_code=201)
async def upload_attachment(
    file: UploadFile = File(...),
    _: dict = Depends(require_account),
):
    """Upload ONE file to attach to a support request. Signed-in users only. The
    frontend calls this once per file, then sends the returned metadata in the
    create-escalation body."""
    ext = Path(file.filename or "").suffix.lower()
    if ext not in _ATTACH_ALLOWED_EXT:
        raise HTTPException(
            status_code=400,
            detail="Tipo de archivo no permitido (imágenes, video, PDF, Word, Excel, TXT o CSV)",
        )

    # Storage guard — refuse uploads when the disk is nearly full, so attachment
    # spam can't exhaust it (defense in depth with the rate limit + retention sweep).
    try:
        free_mb = shutil.disk_usage(settings.local_storage_path).free / (1024 * 1024)
        if free_mb < settings.min_free_disk_mb:
            raise HTTPException(status_code=507, detail="Almacenamiento no disponible temporalmente. Intenta más tarde.")
    except FileNotFoundError:
        pass  # storage dir not created yet — the save below will create it

    # Stream to a temp file; keep the first 64 KB in memory for validation.
    head = b""
    total = 0
    with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as tmp:
        tmp_path = tmp.name
        while chunk := await file.read(1024 * 1024):
            total += len(chunk)
            if total > _ATTACH_MAX_BYTES:
                break
            if len(head) < 65536:
                head += chunk[: 65536 - len(head)]
            tmp.write(chunk)

    def _reject(status: int, detail: str):
        Path(tmp_path).unlink(missing_ok=True)
        raise HTTPException(status_code=status, detail=detail)

    if total > _ATTACH_MAX_BYTES:
        _reject(413, f"El archivo supera el límite de {_ATTACH_MAX_BYTES // (1024 * 1024)} MB")

    # Content validation — extension-spoofing prevention.
    content_type = "application/octet-stream"
    if ext in _ATTACH_TEXT_EXT:
        if not _looks_like_text(head):
            _reject(400, "Tipo de contenido no permitido")
        content_type = "text/csv" if ext == ".csv" else "text/plain"
    else:
        kind = filetype.guess(head[:8192])
        detected = kind.extension if kind else None
        if detected not in _ATTACH_DETECTED:
            _reject(400, "Tipo de contenido no permitido")
        content_type = kind.mime

    try:
        url = await asyncio.to_thread(save_file, tmp_path, file.filename, "escalation")
    except Exception as exc:
        Path(tmp_path).unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail=f"Error al guardar el archivo: {exc}")
    Path(tmp_path).unlink(missing_ok=True)

    return {
        "file_name": _safe_filename(file.filename or "archivo"),
        "url": url,
        "content_type": content_type,
        "size": total,
    }


@router.post("/escalations", status_code=201)
async def create_escalation(
    body: EscalationRequestBody,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(require_account),
):
    """Signed-in users only — see require_account."""
    session_uuid: uuid.UUID | None = None
    if body.session_id:
        try:
            session_uuid = uuid.UUID(body.session_id)
        except ValueError:
            raise HTTPException(status_code=422, detail="ID de sesión inválido")

    # Only accept URLs our own upload endpoint produced — never an arbitrary
    # /data path (which could point at an indexed KB document).
    for a in body.attachments:
        if not a.url.startswith(_ATTACH_URL_PREFIX):
            raise HTTPException(status_code=422, detail="Adjunto inválido")

    record = EscalationRequest(
        session_id=session_uuid,
        user_id=user["uid"],
        user_label=user.get("email") or user["uid"],
        contact=body.contact.strip(),
        name=body.name.strip() if body.name else None,
        reason=body.reason,
        attachments=[a.model_dump() for a in body.attachments],
    )
    db.add(record)
    await db.commit()
    await db.refresh(record)

    background_tasks.add_task(_notify, record)
    return {"id": str(record.id), "status": record.status}


@router.get("/admin/escalations")
async def list_escalations(
    status: str | None = None,
    db: AsyncSession = Depends(get_db),
    _: dict = Depends(require_admin),
):
    stmt = select(EscalationRequest).order_by(EscalationRequest.created_at.desc()).limit(200)
    if status in _STATUSES:
        stmt = stmt.where(EscalationRequest.status == status)
    rows = (await db.execute(stmt)).scalars().all()

    new_count = (await db.execute(
        select(func.count()).select_from(EscalationRequest).where(EscalationRequest.status == "new")
    )).scalar_one()

    return {
        "new_count": int(new_count),
        "items": [
            {
                "id": str(r.id),
                "session_id": str(r.session_id) if r.session_id else None,
                "user_label": r.user_label,
                "contact": r.contact,
                "name": r.name,
                "reason": r.reason,
                "attachments": r.attachments or [],
                "status": r.status,
                "created_at": r.created_at.isoformat(),
            }
            for r in rows
        ],
    }


@router.patch("/admin/escalations/{escalation_id}")
async def update_escalation(
    escalation_id: str,
    body: StatusUpdate,
    db: AsyncSession = Depends(get_db),
    _: dict = Depends(require_admin),
):
    try:
        eid = uuid.UUID(escalation_id)
    except ValueError:
        raise HTTPException(status_code=422, detail="ID de escalación inválido")
    result = await db.execute(
        sql_update(EscalationRequest)
        .where(EscalationRequest.id == eid)
        .values(status=body.status, updated_at=datetime.utcnow())
        .returning(EscalationRequest.id)
    )
    if result.first() is None:
        raise HTTPException(status_code=404, detail="Escalación no encontrada")
    await db.commit()
    return {"id": escalation_id, "status": body.status}


# ── Retention sweep (called at startup) ───────────────────────────────────────

async def evict_old_attachments() -> None:
    """Delete attachment files of resolved requests older than the retention
    window and clear their metadata. Safe: only touches resolved+aged requests,
    never open ones. Keeps /data/escalations from growing without bound."""
    cutoff = datetime.utcnow() - timedelta(days=settings.attachment_retention_days)
    base = Path(settings.local_storage_path)
    try:
        async with AsyncSessionLocal() as db:
            rows = (await db.execute(
                select(EscalationRequest).where(
                    EscalationRequest.status == "resolved",
                    EscalationRequest.updated_at < cutoff,
                )
            )).scalars().all()
            changed = False
            for r in rows:
                if not r.attachments:
                    continue
                for a in r.attachments:
                    url = a.get("url", "")
                    if url.startswith(_ATTACH_URL_PREFIX):
                        (base / url[len("/data/"):]).unlink(missing_ok=True)
                r.attachments = []
                changed = True
            if changed:
                await db.commit()
    except Exception as exc:
        logger.error("Attachment retention sweep failed: %s", exc)
