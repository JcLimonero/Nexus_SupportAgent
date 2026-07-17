import uuid
import asyncio
import secrets
import shutil
import tempfile
from pathlib import Path

import filetype
from fastapi import APIRouter, Depends, UploadFile, File, HTTPException, BackgroundTasks
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, delete, func

from db.connection import get_db, AsyncSessionLocal
from db.models import DocumentChunk, ResponseCache, User, ChatSession, ChatMessage, MessageFeedback
from auth.firebase_verify import get_current_user
from ingestion.pdf_processor import extract_pdf_chunks
from ingestion.video_processor import extract_media_chunks
from ingestion.document_processor import extract_document_chunks
from retrieval.vector_search import embed_documents
from config import get_settings

settings = get_settings()
router = APIRouter(prefix="/api/admin", tags=["admin"])

_MAX_UPLOAD_BYTES = 100 * 1024 * 1024  # 100 MB hard cap

# Binary formats validated by magic bytes (extension → expected MIME via filetype).
_BINARY_MIME = {
    ".pdf":  {"application/pdf"},
    ".mp4":  {"video/mp4"},
    ".docx": {"application/vnd.openxmlformats-officedocument.wordprocessingml.document"},
    ".pptx": {"application/vnd.openxmlformats-officedocument.presentationml.presentation"},
}
# Audio formats — magic-byte validated by MIME family (any audio/*). All decode
# through the same ffmpeg → Whisper path as video, so they transcribe identically.
_AUDIO_EXTENSIONS = {".mp3", ".m4a", ".wav", ".ogg"}
# Plain-text formats have no magic bytes — validated by a UTF-8 text-decode check.
_TEXT_EXTENSIONS = {".txt", ".md", ".csv"}

_ALLOWED_EXTENSIONS = set(_BINARY_MIME) | _AUDIO_EXTENSIONS | _TEXT_EXTENSIONS

# Extension → source_type used for storage subfolder and DocumentChunk.source_type.
_SOURCE_TYPE = {
    ".pdf": "pdf", ".mp4": "video", ".docx": "docx",
    ".pptx": "pptx", ".txt": "txt", ".md": "md", ".csv": "csv",
    ".mp3": "audio", ".m4a": "audio", ".wav": "audio", ".ogg": "audio",
}

def _looks_like_text(content: bytes) -> bool:
    """Heuristic for plain-text uploads: decodes as UTF-8 and has no NUL bytes."""
    if b"\x00" in content:
        return False
    try:
        content.decode("utf-8")
    except UnicodeDecodeError:
        # Allow a small tail of multi-byte chars cut mid-sequence by the size cap.
        try:
            content[:-4].decode("utf-8")
        except UnicodeDecodeError:
            return False
    return True


# ── Admin guard ───────────────────────────────────────────────────────────────

def require_admin(user: dict = Depends(get_current_user)) -> dict:
    if not user.get("is_admin"):
        raise HTTPException(status_code=403, detail="Se requieren permisos de administrador")
    return user


# ── Storage helpers ──────────────────────────────────────────────────────────

def _safe_filename(name: str) -> str:
    """Strip path separators to prevent path traversal via filename."""
    return Path(name).name.replace("\x00", "")


def _save_local(tmp_path: str, file_name: str, source_type: str) -> str:
    dest_dir = Path(settings.local_storage_path) / f"{source_type}s"
    dest_dir.mkdir(parents=True, exist_ok=True)
    safe_name = _safe_filename(file_name)
    dest = dest_dir / f"{uuid.uuid4()}_{safe_name}"
    shutil.copy2(tmp_path, dest)
    return f"/data/{source_type}s/{dest.name}"


def _save_gcs(tmp_path: str, file_name: str, source_type: str) -> str:
    from google.cloud import storage as gcs
    client = gcs.Client()
    bucket = client.bucket(settings.gcs_bucket_name)
    safe_name = _safe_filename(file_name)
    blob_name = f"{source_type}s/{uuid.uuid4()}/{safe_name}"
    bucket.blob(blob_name).upload_from_filename(tmp_path)
    return f"https://storage.googleapis.com/{settings.gcs_bucket_name}/{blob_name}"


def save_file(tmp_path: str, file_name: str, source_type: str) -> str:
    if settings.storage_provider == "local":
        return _save_local(tmp_path, file_name, source_type)
    return _save_gcs(tmp_path, file_name, source_type)


# ── Background indexing ──────────────────────────────────────────────────────

# ponytail: one indexing job at a time — ffmpeg + Whisper + embedding share the
# API container's CPU and concurrent jobs starve chat latency. Move indexing to
# a worker container if upload throughput ever matters.
_INDEX_SEM = asyncio.Semaphore(1)


async def _process_and_index(file_path: str, file_name: str, file_url: str, source_type: str, ext: str):
    try:
        async with _INDEX_SEM:
            if source_type == "pdf":
                chunks = await asyncio.to_thread(extract_pdf_chunks, file_path, file_name, file_url)
            elif source_type in ("video", "audio"):
                chunks = await asyncio.to_thread(extract_media_chunks, file_path, file_name, file_url, source_type)
            else:
                chunks = await asyncio.to_thread(extract_document_chunks, file_path, file_name, file_url, ext)

            embeddings = await asyncio.to_thread(
                embed_documents, [c["content"] for c in chunks]
            )
            async with AsyncSessionLocal() as db:
                for chunk, embedding in zip(chunks, embeddings):
                    db.add(DocumentChunk(
                        content=chunk["content"],
                        embedding=embedding,
                        source_type=chunk["source_type"],
                        file_name=chunk["file_name"],
                        gcs_url=chunk["gcs_url"],
                        page_number=chunk["page_number"],
                        chunk_index=chunk["chunk_index"],
                        start_time=chunk.get("start_time"),
                    ))
                await db.commit()
    finally:
        Path(file_path).unlink(missing_ok=True)


# ── Routes ───────────────────────────────────────────────────────────────────

@router.post("/upload")
async def upload_file(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    _: dict = Depends(require_admin),
):
    # Extension fast-fail
    ext = Path(file.filename).suffix.lower()
    if ext not in _ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail="Solo se aceptan archivos PDF, MP4, MP3, M4A, WAV, OGG, DOCX, PPTX, TXT, MD y CSV",
        )

    source_type = _SOURCE_TYPE[ext]

    # Stream to a temp file in 1 MB chunks — never hold a 100 MB upload in RAM.
    # Keep the first 64 KB in memory for content validation below.
    head = b""
    total = 0
    with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as tmp:
        tmp_path = tmp.name
        while chunk := await file.read(1024 * 1024):
            total += len(chunk)
            if total > _MAX_UPLOAD_BYTES:
                break
            if len(head) < 65536:
                head += chunk[: 65536 - len(head)]
            tmp.write(chunk)

    def _reject(status: int, detail: str):
        Path(tmp_path).unlink(missing_ok=True)
        raise HTTPException(status_code=status, detail=detail)

    if total > _MAX_UPLOAD_BYTES:
        _reject(413, "El archivo supera el límite de 100 MB")

    # Content validation — extension-spoofing prevention.
    if ext in _TEXT_EXTENSIONS:
        # No magic bytes for plain text; reject binary disguised as text.
        # Validating the first 64 KB is enough to catch disguised binaries.
        if not _looks_like_text(head):
            _reject(400, "Tipo de contenido no permitido")
    elif ext in _AUDIO_EXTENSIONS:
        # Accept any audio/* container; .m4a shares the MP4 box so may report
        # video/mp4. ffmpeg sorts out the actual codec downstream.
        kind = filetype.guess(head[:8192])
        ok = kind is not None and (
            kind.mime.startswith("audio/") or (ext == ".m4a" and kind.mime == "video/mp4")
        )
        if not ok:
            _reject(400, "Tipo de contenido no permitido")
    else:
        # Magic bytes for binary formats. OOXML (docx/pptx) is zip-based and the
        # marker may sit past the first 512 bytes, so scan a larger prefix.
        kind = filetype.guess(head[:8192])
        if kind is None or kind.mime not in _BINARY_MIME[ext]:
            _reject(400, "Tipo de contenido no permitido")

    try:
        file_url = await asyncio.to_thread(save_file, tmp_path, file.filename, source_type)
    except Exception as e:
        Path(tmp_path).unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail=f"Error al guardar el archivo: {e}")

    background_tasks.add_task(_process_and_index, tmp_path, file.filename, file_url, source_type, ext)

    # Invalidate semantic cache — new document may change correct answers
    async with AsyncSessionLocal() as flush_db:
        await flush_db.execute(delete(ResponseCache))
        await flush_db.commit()
    # Suggested questions are derived from the corpus — refresh them too.
    from routers.chat import clear_suggestions_cache
    clear_suggestions_cache()

    return {"status": "processing", "file_name": file.filename, "url": file_url}


@router.get("/documents")
async def list_documents(
    db: AsyncSession = Depends(get_db),
    _: dict = Depends(require_admin),
):
    result = await db.execute(
        select(DocumentChunk.file_name, DocumentChunk.source_type, DocumentChunk.gcs_url)
        .distinct(DocumentChunk.file_name)
    )
    return [
        {"file_name": r.file_name, "source_type": r.source_type, "gcs_url": r.gcs_url}
        for r in result.fetchall()
    ]


@router.delete("/documents/{file_name:path}")
async def delete_document(
    file_name: str,
    db: AsyncSession = Depends(get_db),
    _: dict = Depends(require_admin),
):
    await db.execute(delete(DocumentChunk).where(DocumentChunk.file_name == file_name))
    await db.execute(delete(ResponseCache))  # knowledge base changed — flush cache
    await db.commit()
    from routers.chat import clear_suggestions_cache
    clear_suggestions_cache()
    return {"status": "deleted", "file_name": file_name}


@router.get("/documents/excerpt/{chunk_id}")
async def get_excerpt(
    chunk_id: str,
    db: AsyncSession = Depends(get_db),
    _: dict = Depends(get_current_user),
):
    try:
        cid = uuid.UUID(chunk_id)
    except ValueError:
        raise HTTPException(status_code=422, detail="ID de fragmento inválido")
    result = await db.execute(select(DocumentChunk).where(DocumentChunk.id == cid))
    chunk = result.scalar_one_or_none()
    if not chunk:
        raise HTTPException(status_code=404, detail="Fragmento no encontrado")
    return {
        "chunk_id": str(chunk.id),
        "file_name": chunk.file_name,
        "source_type": chunk.source_type,
        "page_number": chunk.page_number,
        "content": chunk.content,
    }


@router.get("/cache/stats")
async def cache_stats(
    db: AsyncSession = Depends(get_db),
    _: dict = Depends(require_admin),
):
    from sqlalchemy import func
    result = await db.execute(
        select(
            func.count(ResponseCache.id).label("total_entries"),
            func.sum(ResponseCache.hit_count).label("total_hits"),
            func.max(ResponseCache.created_at).label("newest_entry"),
        )
    )
    row = result.first()
    return {
        "total_entries": row.total_entries or 0,
        "total_hits": int(row.total_hits or 0),
        "newest_entry": row.newest_entry.isoformat() if row.newest_entry else None,
    }


@router.delete("/cache", status_code=204)
async def flush_cache(
    db: AsyncSession = Depends(get_db),
    _: dict = Depends(require_admin),
):
    await db.execute(delete(ResponseCache))
    await db.commit()


# ── Dashboard stats ───────────────────────────────────────────────────────────

@router.get("/stats")
async def dashboard_stats(
    db: AsyncSession = Depends(get_db),
    _: dict = Depends(require_admin),
):
    total_users    = (await db.execute(select(func.count()).select_from(User))).scalar_one()
    active_users   = (await db.execute(select(func.count()).select_from(User).where(User.is_active == True))).scalar_one()
    total_sessions = (await db.execute(select(func.count()).select_from(ChatSession))).scalar_one()
    total_messages = (await db.execute(select(func.count()).select_from(ChatMessage))).scalar_one()
    total_docs     = (await db.execute(select(func.count(func.distinct(DocumentChunk.file_name))).select_from(DocumentChunk))).scalar_one()
    cache_entries  = (await db.execute(select(func.count()).select_from(ResponseCache))).scalar_one()
    cache_hits     = (await db.execute(select(func.coalesce(func.sum(ResponseCache.hit_count), 0)))).scalar_one()
    thumbs_up      = (await db.execute(select(func.count()).select_from(MessageFeedback).where(MessageFeedback.rating == "up"))).scalar_one()
    thumbs_down    = (await db.execute(select(func.count()).select_from(MessageFeedback).where(MessageFeedback.rating == "down"))).scalar_one()

    return {
        "users":         {"total": total_users, "active": active_users},
        "sessions":      {"total": total_sessions},
        "messages":      {"total": total_messages},
        "documents":     {"total": total_docs},
        "cache":         {"entries": cache_entries, "total_hits": int(cache_hits)},
        "feedback":      {"up": thumbs_up, "down": thumbs_down},
    }


# ── Conversation viewer (traceability / audit) ────────────────────────────────

@router.get("/conversations")
async def list_conversations(
    filter: str = "all",            # all | registered | anonymous
    q: str | None = None,           # search across label + title
    user_id: str | None = None,     # drill-in from the users panel
    limit: int = 50,
    offset: int = 0,
    db: AsyncSession = Depends(get_db),
    _: dict = Depends(require_admin),
):
    limit = max(1, min(limit, 100))
    offset = max(0, offset)

    msg_count = func.count(ChatMessage.id).label("message_count")
    last_at = func.max(ChatMessage.created_at).label("last_message_at")
    stmt = (
        select(ChatSession, msg_count, last_at)
        .outerjoin(ChatMessage, ChatMessage.session_id == ChatSession.id)
        .group_by(ChatSession.id)
        .order_by(func.coalesce(last_at, ChatSession.created_at).desc())
    )

    if filter == "registered":
        stmt = stmt.where(ChatSession.is_anonymous == False)  # noqa: E712
    elif filter == "anonymous":
        stmt = stmt.where(ChatSession.is_anonymous == True)   # noqa: E712
    if user_id:
        stmt = stmt.where(ChatSession.user_id == user_id)
    if q:
        like = f"%{q.strip()}%"
        stmt = stmt.where(
            func.coalesce(ChatSession.user_label, "").ilike(like)
            | func.coalesce(ChatSession.title, "").ilike(like)
        )

    rows = (await db.execute(stmt.limit(limit).offset(offset))).all()
    return [
        {
            "id": str(s.id),
            "user_id": s.user_id,
            "user_label": s.user_label,
            "is_anonymous": s.is_anonymous,
            "title": s.title,
            "message_count": int(count or 0),
            "created_at": s.created_at.isoformat(),
            "last_message_at": last.isoformat() if last else None,
        }
        for s, count, last in rows
    ]


@router.get("/conversations/{session_id}")
async def get_conversation(
    session_id: str,
    db: AsyncSession = Depends(get_db),
    _: dict = Depends(require_admin),
):
    try:
        sid = uuid.UUID(session_id)
    except ValueError:
        raise HTTPException(status_code=422, detail="ID de conversación inválido")
    session = (await db.execute(select(ChatSession).where(ChatSession.id == sid))).scalar_one_or_none()
    if not session:
        raise HTTPException(status_code=404, detail="Conversación no encontrada")
    msgs = (await db.execute(
        select(ChatMessage).where(ChatMessage.session_id == sid).order_by(ChatMessage.created_at)
    )).scalars().all()
    return {
        "id": str(session.id),
        "user_id": session.user_id,
        "user_label": session.user_label,
        "is_anonymous": session.is_anonymous,
        "title": session.title,
        "created_at": session.created_at.isoformat(),
        "messages": [
            {
                "id": str(m.id),
                "role": m.role,
                "content": m.content,
                "sources": m.sources,
                "created_at": m.created_at.isoformat(),
            }
            for m in msgs
        ],
    }


@router.delete("/conversations/{session_id}", status_code=204)
async def delete_conversation(
    session_id: str,
    db: AsyncSession = Depends(get_db),
    _: dict = Depends(require_admin),
):
    try:
        sid = uuid.UUID(session_id)
    except ValueError:
        raise HTTPException(status_code=422, detail="ID de conversación inválido")
    session = (await db.execute(select(ChatSession).where(ChatSession.id == sid))).scalar_one_or_none()
    if not session:
        raise HTTPException(status_code=404, detail="Conversación no encontrada")
    # Remove feedback on this session's messages, then messages, then the session.
    msg_ids = (await db.execute(
        select(ChatMessage.id).where(ChatMessage.session_id == sid)
    )).scalars().all()
    if msg_ids:
        await db.execute(delete(MessageFeedback).where(MessageFeedback.message_id.in_(msg_ids)))
    await db.execute(delete(ChatMessage).where(ChatMessage.session_id == sid))
    await db.delete(session)
    await db.commit()


@router.post("/conversations/{session_id}/share")
async def share_conversation(
    session_id: str,
    db: AsyncSession = Depends(get_db),
    _: dict = Depends(require_admin),
):
    """Create (or return) a public share token for any conversation (admin)."""
    try:
        sid = uuid.UUID(session_id)
    except ValueError:
        raise HTTPException(status_code=422, detail="ID de conversación inválido")
    session = (await db.execute(select(ChatSession).where(ChatSession.id == sid))).scalar_one_or_none()
    if not session:
        raise HTTPException(status_code=404, detail="Conversación no encontrada")
    if not session.share_token:
        session.share_token = secrets.token_urlsafe(16)
        await db.commit()
    return {"token": session.share_token, "path": f"/shared/{session.share_token}"}
