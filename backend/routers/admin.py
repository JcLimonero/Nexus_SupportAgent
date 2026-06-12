import os
import uuid
import asyncio
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
from ingestion.video_processor import extract_video_chunks
from retrieval.vector_search import embed_document
from config import get_settings

settings = get_settings()
router = APIRouter(prefix="/api/admin", tags=["admin"])

_MAX_UPLOAD_BYTES = 100 * 1024 * 1024  # 100 MB hard cap
_ALLOWED_MIME = {"application/pdf", "video/mp4"}


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

async def _process_and_index(file_path: str, file_name: str, file_url: str, source_type: str):
    try:
        if source_type == "pdf":
            chunks = await asyncio.to_thread(extract_pdf_chunks, file_path, file_name, file_url)
        else:
            chunks = await asyncio.to_thread(extract_video_chunks, file_path, file_name, file_url)

        async with AsyncSessionLocal() as db:
            for chunk in chunks:
                embedding = await asyncio.to_thread(embed_document, chunk["content"])
                db.add(DocumentChunk(
                    content=chunk["content"],
                    embedding=embedding,
                    source_type=chunk["source_type"],
                    file_name=chunk["file_name"],
                    gcs_url=chunk["gcs_url"],
                    page_number=chunk["page_number"],
                    chunk_index=chunk["chunk_index"],
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
    if ext not in {".pdf", ".mp4"}:
        raise HTTPException(status_code=400, detail="Solo se aceptan archivos PDF y MP4")

    source_type = "pdf" if ext == ".pdf" else "video"

    # Read with hard size cap to prevent OOM uploads
    content = await file.read(_MAX_UPLOAD_BYTES + 1)
    if len(content) > _MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="El archivo supera el límite de 100 MB")

    # Magic bytes validation — extension spoofing prevention
    kind = filetype.guess(content[:512])
    if kind is None or kind.mime not in _ALLOWED_MIME:
        raise HTTPException(status_code=400, detail="Tipo de contenido no permitido")

    with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as tmp:
        tmp.write(content)
        tmp_path = tmp.name

    try:
        file_url = await asyncio.to_thread(save_file, tmp_path, file.filename, source_type)
    except Exception as e:
        Path(tmp_path).unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail=f"Error al guardar el archivo: {e}")

    background_tasks.add_task(_process_and_index, tmp_path, file.filename, file_url, source_type)

    # Invalidate semantic cache — new document may change correct answers
    async with AsyncSessionLocal() as flush_db:
        await flush_db.execute(delete(ResponseCache))
        await flush_db.commit()

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
    return {"status": "deleted", "file_name": file_name}


@router.get("/documents/excerpt/{chunk_id}")
async def get_excerpt(
    chunk_id: str,
    db: AsyncSession = Depends(get_db),
    _: dict = Depends(require_admin),
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


@router.get("/documents/serve/{file_path:path}")
async def serve_document(
    file_path: str,
    _: dict = Depends(require_admin),
):
    if settings.storage_provider != "local":
        raise HTTPException(status_code=501, detail="Solo disponible en almacenamiento local")
    base = Path(settings.local_storage_path).resolve()
    target = (base / file_path).resolve()
    if not str(target).startswith(str(base) + os.sep):
        raise HTTPException(status_code=403, detail="Acceso denegado")
    if not target.exists():
        raise HTTPException(status_code=404, detail="Archivo no encontrado")
    from fastapi.responses import FileResponse
    media = "application/pdf" if target.suffix.lower() == ".pdf" else "video/mp4"
    return FileResponse(str(target), media_type=media, filename=target.name)


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
