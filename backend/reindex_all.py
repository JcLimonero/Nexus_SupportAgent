"""Re-index documents already stored on disk, in place.

Needed whenever the *indexing* changes rather than the files: enabling OCR
(phase 26), switching embedding provider/model, or changing chunk sizes. Each
file's chunks are replaced atomically, so this is safe to re-run and safe to
interrupt — worst case a file keeps its old chunks until the next run.

    # everything
    docker compose run --rm backend python reindex_all.py

    # just the scanned manuals, after enabling OCR
    docker compose run --rm backend python reindex_all.py --only pdf

    # see what would happen, touch nothing
    docker compose run --rm backend python reindex_all.py --dry-run

Media (video/audio) is EXCLUDED by default: re-running Whisper is far slower
than re-reading a PDF and is rarely what you want here. Pass --include-media
when the embedding model changed and transcripts must be re-embedded too — or
use reindex_media.py, which re-transcribes for start_time backfill.

Flushes the semantic cache at the end: cached answers were produced from the
old chunks and would mask the new ones.
"""
import argparse
import asyncio
from pathlib import Path

from sqlalchemy import select, delete, func

from db.connection import AsyncSessionLocal, init_db
from db.models import DocumentChunk, ResponseCache
from ingestion.pdf_processor import extract_pdf_chunks
from ingestion.video_processor import extract_media_chunks
from ingestion.document_processor import extract_document_chunks
from retrieval.vector_search import embed_documents
from config import get_settings

settings = get_settings()

MEDIA_TYPES = {"video", "audio"}


def _resolve_local_path(gcs_url: str) -> str | None:
    """Local file path for a stored url, or None if it lives in GCS."""
    if gcs_url.startswith("/data/"):
        return str(Path(settings.local_storage_path) / gcs_url[len("/data/"):])
    return None


def _extract(local_path: str, file_name: str, gcs_url: str, source_type: str) -> list[dict]:
    """Route a stored file back through the same processor the upload used."""
    if source_type == "pdf":
        return extract_pdf_chunks(local_path, file_name, gcs_url)
    if source_type in MEDIA_TYPES:
        return extract_media_chunks(local_path, file_name, gcs_url, source_type)
    # Document processors dispatch on the extension, not the source_type.
    return extract_document_chunks(local_path, file_name, gcs_url, f".{source_type}")


async def reindex(only: set[str] | None, include_media: bool, name_filter: str, dry_run: bool) -> None:
    await init_db()

    async with AsyncSessionLocal() as db:
        rows = (await db.execute(
            select(
                DocumentChunk.file_name,
                DocumentChunk.gcs_url,
                DocumentChunk.source_type,
                func.count(DocumentChunk.id).label("chunks"),
            ).group_by(DocumentChunk.file_name, DocumentChunk.gcs_url, DocumentChunk.source_type)
            .order_by(DocumentChunk.file_name)
        )).all()

    targets = []
    for file_name, gcs_url, source_type, chunk_count in rows:
        if source_type in MEDIA_TYPES and not include_media:
            continue
        if only and source_type not in only:
            continue
        if name_filter and name_filter.lower() not in file_name.lower():
            continue
        targets.append((file_name, gcs_url, source_type, chunk_count))

    print(f"{len(targets)} archivo(s) a re-indexar (de {len(rows)} en el índice).")
    if settings.ocr_enabled:
        print(f"OCR activo: páginas con <{settings.ocr_min_chars} chars se releen "
              f"con Tesseract ({settings.ocr_language}, {settings.ocr_dpi} dpi).")
    if dry_run:
        for file_name, _, source_type, chunk_count in targets:
            print(f"  · {file_name} ({source_type}, {chunk_count} chunks actuales)")
        print("\n--dry-run: no se modificó nada.")
        return

    total_before = total_after = 0
    failed: list[str] = []

    for file_name, gcs_url, source_type, chunk_count in targets:
        print(f"  → {file_name} ({source_type}, {chunk_count} chunks)")
        local = _resolve_local_path(gcs_url)
        if local is None:
            print("    ! almacenado en GCS, omitido (usa reindex_media.py o re-sube el archivo)")
            failed.append(file_name)
            continue
        if not Path(local).exists():
            print(f"    ! archivo ausente en disco, omitido: {local}")
            failed.append(file_name)
            continue

        try:
            chunks = await asyncio.to_thread(_extract, local, file_name, gcs_url, source_type)
            if not chunks:
                print("    ! la extracción no produjo chunks, se conservan los anteriores")
                failed.append(file_name)
                continue
            embeddings = await asyncio.to_thread(embed_documents, [c["content"] for c in chunks])
        except Exception as exc:
            print(f"    ! error al procesar, se conservan los chunks anteriores: {exc}")
            failed.append(file_name)
            continue

        async with AsyncSessionLocal() as db:
            # Replace only this file's chunks, keyed by its unique stored url.
            await db.execute(delete(DocumentChunk).where(DocumentChunk.gcs_url == gcs_url))
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

        chars = sum(len(c["content"]) for c in chunks)
        total_before += chunk_count
        total_after += len(chunks)
        print(f"    ✓ {len(chunks)} chunks, {chars} chars")

    async with AsyncSessionLocal() as db:
        await db.execute(delete(ResponseCache))
        await db.commit()

    print(f"\nListo. Chunks: {total_before} → {total_after}. Caché semántico vaciado.")
    if failed:
        print(f"Omitidos ({len(failed)}): {', '.join(failed)}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Re-indexa documentos ya almacenados.")
    parser.add_argument("--only", help="source_types separados por coma, ej. pdf o pdf,docx")
    parser.add_argument("--file", default="", help="re-indexa solo los archivos cuyo nombre contenga este texto")
    parser.add_argument("--include-media", action="store_true", help="incluye video/audio (re-ejecuta Whisper, lento)")
    parser.add_argument("--dry-run", action="store_true", help="lista lo que haría sin tocar la base")
    args = parser.parse_args()

    asyncio.run(reindex(
        only={s.strip() for s in args.only.split(",")} if args.only else None,
        include_media=args.include_media,
        name_filter=args.file,
        dry_run=args.dry_run,
    ))
