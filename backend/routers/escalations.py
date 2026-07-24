import asyncio
import base64
import json
import logging
import re
import secrets
import shutil
import tempfile
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timedelta
from pathlib import Path

import filetype
from fastapi import APIRouter, BackgroundTasks, Depends, File, HTTPException, UploadFile
from typing import Annotated

from pydantic import BaseModel, Field, StringConstraints, field_validator, model_validator
from sqlalchemy import select, update as sql_update, func
from sqlalchemy.ext.asyncio import AsyncSession

from db.connection import get_db, AsyncSessionLocal
from db.models import ChatMessage, ChatSession, EscalationRequest
from auth.firebase_verify import get_current_user
from routers.admin import require_admin, save_file, _safe_filename, _looks_like_text
from config import get_settings
from transcript import format_transcript, render_pdf

logger = logging.getLogger(__name__)
settings = get_settings()

router = APIRouter(prefix="/api", tags=["escalations"])

_STATUSES = ("new", "in_progress", "resolved")
_EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")


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


# ── Conversation snapshot (PDF + text for the email) ──────────────────────────
_TRANSCRIPT_NAME = "conversacion.pdf"
_MAIL_TRANSCRIPT_CHARS = 8000   # EmailJS caps request size; the PDF has it all


async def _snapshot_conversation(db: AsyncSession, session_uuid: uuid.UUID, uid: str):
    """The user's chat as (text, share link, path to a rendered PDF) — what
    support needs to see what was tried and what happened. Returns empties if
    the session isn't the requester's: a chat that started as a guest shouldn't
    block the ticket. The caller owns (and deletes) the temp file."""
    session = (await db.execute(
        select(ChatSession).where(ChatSession.id == session_uuid, ChatSession.user_id == uid)
    )).scalar_one_or_none()
    if session is None:
        return "", "", None
    messages = (await db.execute(
        select(ChatMessage).where(ChatMessage.session_id == session_uuid).order_by(ChatMessage.created_at)
    )).scalars().all()
    if not messages:
        return "", "", None

    # Same public read-only link the "Compartir" button mints (chat.py), so
    # support can open the conversation without an account.
    if not session.share_token:
        session.share_token = secrets.token_urlsafe(16)
    share_link = f"{settings.public_origin}/shared/{session.share_token}" if settings.public_origin else ""

    def _render() -> str:
        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
            path = tmp.name
        try:
            render_pdf(path, session.title, messages)
        except Exception:
            Path(path).unlink(missing_ok=True)   # the caller never sees the path
            raise
        return path

    return format_transcript(messages, _MAIL_TRANSCRIPT_CHARS), share_link, await asyncio.to_thread(_render)


# ── Email notification via EmailJS (best-effort) ──────────────────────────────

_EMAILJS_URL = "https://api.emailjs.com/api/v1.0/email/send"


def _send_via_emailjs(template_params: dict) -> bool:
    """Blocking server-side POST to EmailJS. No-op if not configured. Never
    raises — the escalation is already saved; email is a bonus, not a guarantee.
    Returns False only when a real send attempt failed."""
    if not (settings.emailjs_service_id and settings.emailjs_template_id and settings.emailjs_public_key):
        logger.info("EmailJS not configured — escalation email skipped")
        return True
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
            # EmailJS sits behind Cloudflare, which answers 403 "error code:
            # 1010" to urllib's default User-Agent. Any real name gets through.
            headers={"Content-Type": "application/json", "User-Agent": "NexusSupportAgent/1.0"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            resp.read()
        return True
    except urllib.error.HTTPError as exc:
        # EmailJS explains itself in the body ("template ID not found", "The
        # attachment size exceeds…"); the status code alone is useless.
        logger.error("EmailJS rejected the send (%s): %s", exc.code, exc.read().decode(errors="replace")[:300])
        return False
    except Exception as exc:
        logger.error("EmailJS send failed: %s", exc)
        return False


async def _notify(
    record: EscalationRequest,
    conversation: str = "",
    share_link: str = "",
    pdf: bytes | None = None,
) -> None:
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
        "conversation": conversation or "(sin conversación)",
        "share_link": share_link,
        "conversation_link": link,
        "to_email": settings.escalation_notify_email,
    }

    encoded = base64.b64encode(pdf).decode() if pdf else ""
    if len(encoded) > settings.emailjs_max_attach_kb * 1024:
        logger.warning("Chat PDF too big for EmailJS (%d KB) — emailing without it", len(encoded) // 1024)
        encoded = ""
    if encoded:
        params["chat_pdf"] = f"data:application/pdf;base64,{encoded}"
        params["chat_pdf_name"] = _TRANSCRIPT_NAME

    if not await asyncio.to_thread(_send_via_emailjs, params) and encoded:
        # An email without the PDF beats no email — the send may have failed
        # because the template has no attachment variable or the plan's size
        # limit is lower than ours. The conversation text and link still go.
        params.pop("chat_pdf")
        params.pop("chat_pdf_name")
        await asyncio.to_thread(_send_via_emailjs, params)


# ── Schemas ───────────────────────────────────────────────────────────────────

class Attachment(BaseModel):
    file_name: str = Field(min_length=1, max_length=255)
    url: str = Field(min_length=1, max_length=500)
    content_type: str | None = Field(default=None, max_length=120)
    size: int | None = None


class EscalationRequestBody(BaseModel):
    # Either one is enough to reach the user back, but we need at least one.
    email: str | None = Field(default=None, max_length=120)
    phone: str | None = Field(default=None, max_length=25)
    name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=2, max_length=80)]
    # Required: a ticket with no description is one support has to chase down.
    # Stripped first so whitespace can't pass for a description.
    reason: Annotated[str, StringConstraints(strip_whitespace=True, min_length=10, max_length=1000)]
    session_id: str | None = None
    attachments: list[Attachment] = Field(default_factory=list, max_length=_ATTACH_MAX_COUNT)

    @field_validator("email")
    @classmethod
    def _valid_email(cls, v: str | None) -> str | None:
        v = (v or "").strip().lower()
        if not v:
            return None
        # Shape check only — no dependency just to parse an address. Same
        # pattern the modal uses, so both sides agree on what's valid.
        if not _EMAIL_RE.match(v):
            raise ValueError("Correo inválido")
        return v

    @field_validator("phone")
    @classmethod
    def _valid_phone(cls, v: str | None) -> str | None:
        digits = "".join(c for c in (v or "") if c.isdigit())
        if not digits:
            return None
        if len(digits) != 10:
            raise ValueError("El teléfono debe tener 10 dígitos")
        return digits

    @model_validator(mode="after")
    def _needs_a_way_back(self):
        if not (self.email or self.phone):
            raise ValueError("Proporciona un correo o un teléfono")
        return self


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

    # The conversation itself: a PDF filed with the request plus the text and
    # public link the email carries. Best-effort — a ticket must never be lost
    # because the snapshot failed.
    attachments = [a.model_dump() for a in body.attachments]
    conversation, share_link, pdf, pdf_path = "", "", None, None
    if session_uuid:
        try:
            conversation, share_link, pdf_path = await _snapshot_conversation(db, session_uuid, user["uid"])
            if pdf_path:
                url = await asyncio.to_thread(save_file, pdf_path, _TRANSCRIPT_NAME, "escalation")
                pdf = Path(pdf_path).read_bytes()
                attachments.insert(0, {
                    "file_name": _TRANSCRIPT_NAME,
                    "url": url,
                    "content_type": "application/pdf",
                    "size": len(pdf),
                })
        except Exception as exc:
            logger.error("Conversation snapshot failed: %s", exc)
        finally:
            if pdf_path:
                Path(pdf_path).unlink(missing_ok=True)

    record = EscalationRequest(
        session_id=session_uuid,
        user_id=user["uid"],
        user_label=user.get("email") or user["uid"],
        # One display string keeps the column (and the admin inbox) as-is; the
        # validated pieces are what matter. ponytail: split into two columns if
        # anything ever needs to act on the address or number on its own.
        contact=" · ".join(p for p in (body.email, body.phone) if p),
        name=body.name,
        reason=body.reason,
        attachments=attachments,
    )
    db.add(record)
    await db.commit()   # also persists the share token minted above
    await db.refresh(record)

    background_tasks.add_task(_notify, record, conversation, share_link, pdf)
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
