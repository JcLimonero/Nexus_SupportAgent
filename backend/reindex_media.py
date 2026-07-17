"""One-off backfill: re-transcribe existing video/audio documents so their
chunks gain start_time (added in phase 19, for jump-to-moment deep links).

Run once after deploying this change:

    docker compose run --rm backend python reindex_media.py

Safe to re-run (it replaces each file's chunks). Slow — it re-runs Whisper on
every media file. Flushes the semantic cache at the end since chunk boundaries,
and therefore answers, may shift.
"""
import asyncio
import tempfile
from pathlib import Path

from sqlalchemy import select, delete

from db.connection import AsyncSessionLocal, init_db
from db.models import DocumentChunk, ResponseCache
from ingestion.video_processor import extract_media_chunks
from retrieval.vector_search import embed_documents
from config import get_settings

settings = get_settings()


def _resolve_local_path(gcs_url: str) -> str | None:
    """Local file path for a stored media url, or None if it lives in GCS."""
    if gcs_url.startswith("/data/"):
        return str(Path(settings.local_storage_path) / gcs_url[len("/data/"):])
    return None


def _download_gcs(gcs_url: str, dest: str) -> None:
    from google.cloud import storage as gcs
    # https://storage.googleapis.com/<bucket>/<blob...>
    rest = gcs_url.split("storage.googleapis.com/", 1)[1]
    bucket_name, blob_name = rest.split("/", 1)
    gcs.Client().bucket(bucket_name).blob(blob_name).download_to_filename(dest)


async def reindex() -> None:
    await init_db()  # ensure the start_time column exists before we write to it

    async with AsyncSessionLocal() as db:
        rows = (await db.execute(
            select(DocumentChunk.file_name, DocumentChunk.gcs_url, DocumentChunk.source_type)
            .where(DocumentChunk.source_type.in_(("video", "audio")))
            .distinct()
        )).all()

    print(f"Found {len(rows)} media file(s) to re-index.")
    for file_name, gcs_url, source_type in rows:
        print(f"  → {file_name} ({source_type})")
        tmp = None
        try:
            local = _resolve_local_path(gcs_url)
            if local is None:
                with tempfile.NamedTemporaryFile(suffix=Path(file_name).suffix, delete=False) as t:
                    tmp = t.name
                _download_gcs(gcs_url, tmp)
                local = tmp
            if not Path(local).exists():
                print(f"    ! file missing, skipping: {local}")
                continue

            chunks = extract_media_chunks(local, file_name, gcs_url, source_type)
            embeddings = embed_documents([c["content"] for c in chunks])
            async with AsyncSessionLocal() as db:
                # Replace only this file's chunks (keyed by its unique stored url).
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
            print(f"    ✓ {len(chunks)} chunks")
        finally:
            if tmp:
                Path(tmp).unlink(missing_ok=True)

    async with AsyncSessionLocal() as db:
        await db.execute(delete(ResponseCache))
        await db.commit()
    print("Done. Semantic cache flushed.")


if __name__ == "__main__":
    asyncio.run(reindex())
