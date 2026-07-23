import asyncio
import logging
import smtplib
import tempfile
import uuid
from datetime import datetime
from email.message import EmailMessage
from pathlib import Path

import filetype
from fastapi import APIRouter, BackgroundTasks, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import select, update as sql_update
from sqlalchemy.ext.asyncio import AsyncSession

from db.connection import get_db
from db.models import EscalationRequest
from auth.firebase_verify import get_current_user
from routers.admin import require_admin, save_file, _safe_filename, _looks_like_text
from config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()

router = APIRouter(prefix="/api", tags=["escalations"])

_STATUSES = ("new", "in_progress", "resolved")

# ── Attachment limits (user/guest uploads — tighter than the admin KB upload) ──
_ATTACH_MAX_BYTES = 25 * 1024 * 1024   # 25 MB per file
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


# ── Email notification (best-effort) ──────────────────────────────────────────

def _send_email(subject: str, body: str) -> None:
    """Blocking SMTP send. No-op if SMTP isn't configured. Never raises — the
    escalation is already saved; email is a bonus, not a guarantee."""
    if not settings.smtp_host or not settings.escalation_notify_email:
        logger.info("SMTP not configured — escalation email skipped")
        return
    try:
        msg = EmailMessage()
        msg["Subject"] = subject
        msg["From"] = settings.smtp_from or settings.smtp_user
        msg["To"] = settings.escalation_notify_email
        msg.set_content(body)
        with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=10) as smtp:
            smtp.starttls()
            if settings.smtp_user:
                smtp.login(settings.smtp_user, settings.smtp_password)
            smtp.send_message(msg)
    except Exception as exc:
        logger.error("Escalation email failed: %s", exc)


async def _notify(record: EscalationRequest) -> None:
    who = record.name or record.user_label or record.user_id
    lines = [
        f"Nueva solicitud de contacto humano de: {who}",
        f"Contacto: {record.contact}",
        f"Motivo: {record.reason or '(sin especificar)'}",
    ]
    if record.attachments:
        names = ", ".join(a.get("file_name", "?") for a in record.attachments)
        lines.append(f"Adjuntos ({len(record.attachments)}): {names}")
    if record.session_id and settings.public_origin:
        lines.append(
            f"Conversación: {settings.public_origin}/admin/conversations?id={record.session_id}"
        )
    await asyncio.to_thread(
        _send_email, f"Nueva solicitud de soporte — {who}", "\n".join(lines)
    )


# ── Schemas ───────────────────────────────────────────────────────────────────

class Attachment(BaseModel):
    file_name: str = Field(min_length=1, max_length=255)
    url: str = Field(min_length=1, max_length=500)
    content_type: str | None = Field(default=None, max_length=120)
    size: int | None = None


class EscalationRequestBody(BaseModel):
    contact: str = Field(min_length=3, max_length=120)
    name: str | None = Field(default=None, max_length=80)
    reason: str | None = Field(default=None, max_length=1000)
    session_id: str | None = None
    attachments: list[Attachment] = Field(default_factory=list, max_length=_ATTACH_MAX_COUNT)


class StatusUpdate(BaseModel):
    status: str = Field(pattern="^(new|in_progress|resolved)$")


# ── Routes ────────────────────────────────────────────────────────────────────

@router.post("/escalations/attachments", status_code=201)
async def upload_attachment(
    file: UploadFile = File(...),
    _: dict = Depends(get_current_user),
):
    """Upload ONE file to attach to a human-escalation request. Available to any
    authenticated user (incl. guests). The frontend calls this once per file, then
    sends the returned metadata in the create-escalation body."""
    ext = Path(file.filename or "").suffix.lower()
    if ext not in _ATTACH_ALLOWED_EXT:
        raise HTTPException(
            status_code=400,
            detail="Tipo de archivo no permitido (imágenes, video, PDF, Word, Excel, TXT o CSV)",
        )

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
        _reject(413, "El archivo supera el límite de 25 MB")

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
    user: dict = Depends(get_current_user),
):
    """Any authenticated user (including guests) can request a human."""
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
        reason=body.reason.strip() if body.reason else None,
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

    from sqlalchemy import func
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
