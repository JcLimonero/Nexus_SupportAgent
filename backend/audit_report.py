"""Read-only production audit: conversations, indexed documents, and a
disk/DB cross-check for orphaned files. Never writes to the DB or deletes
anything. Run against the live stack with docker compose (see CLAUDE.md
"One-off scripts"):

    docker compose -f docker-compose.prod.yml run --rm \\
        -v ${PWD}/audit_output:/audit backend python audit_report.py

Writes CSV files (Excel-friendly, utf-8-sig) plus resumen.json to --out
(default /audit, meant to be a bind-mounted host folder).
"""
import argparse
import asyncio
import csv
import json
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import select, func

from db.connection import AsyncSessionLocal
from db.models import ChatSession, ChatMessage, DocumentChunk, EscalationRequest, MessageFeedback
from config import get_settings

settings = get_settings()

# Mirrors chat.py's exact fallback prefix — messages starting with this mean
# retrieval found nothing usable, a useful signal for tuning retrieval_max_distance.
_NO_INFO_PREFIX = "No tengo información sobre ese tema"


def _write_csv(path: Path, rows: list[dict], fieldnames: list[str]) -> None:
    with path.open("w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


async def _export_conversations(db, out: Path) -> dict:
    sessions = (await db.execute(select(ChatSession))).scalars().all()
    messages = (await db.execute(
        select(ChatMessage).order_by(ChatMessage.session_id, ChatMessage.created_at)
    )).scalars().all()

    msgs_by_session: dict = {}
    for m in messages:
        msgs_by_session.setdefault(m.session_id, []).append(m)

    session_label = {s.id: (s.user_label or s.user_id) for s in sessions}

    session_rows = [{
        "session_id": str(s.id),
        "user_id": s.user_id,
        "user_label": s.user_label or "",
        "is_anonymous": s.is_anonymous,
        "title": s.title or "",
        "message_count": len(msgs_by_session.get(s.id, [])),
        "created_at": s.created_at.isoformat(),
        "updated_at": s.updated_at.isoformat(),
        "shared": bool(s.share_token),
    } for s in sessions]
    _write_csv(
        out / "conversaciones_sesiones.csv", session_rows,
        ["session_id", "user_id", "user_label", "is_anonymous", "title",
         "message_count", "created_at", "updated_at", "shared"],
    )

    message_rows = [{
        "session_id": str(m.session_id),
        "user_label": session_label.get(m.session_id, ""),
        "role": m.role,
        "content": m.content,
        "sources": json.dumps(m.sources, ensure_ascii=False) if m.sources else "",
        "created_at": m.created_at.isoformat(),
    } for m in messages]
    _write_csv(
        out / "conversaciones_mensajes.csv", message_rows,
        ["session_id", "user_label", "role", "content", "sources", "created_at"],
    )

    # "No info" pairs: the user question immediately followed by the fallback
    # answer, one row per occurrence — direct input for retrieval tuning.
    no_info_rows = []
    assistant_total = 0
    for sid, msgs in msgs_by_session.items():
        prev_user = None
        for m in msgs:
            if m.role == "user":
                prev_user = m
                continue
            if m.role != "assistant":
                continue
            assistant_total += 1
            if m.content.strip().startswith(_NO_INFO_PREFIX):
                no_info_rows.append({
                    "session_id": str(sid),
                    "user_label": session_label.get(sid, ""),
                    "pregunta": prev_user.content if prev_user else "",
                    "created_at": m.created_at.isoformat(),
                })
    _write_csv(
        out / "preguntas_sin_respuesta.csv", no_info_rows,
        ["session_id", "user_label", "pregunta", "created_at"],
    )

    feedback = (await db.execute(select(MessageFeedback.rating, func.count()).group_by(MessageFeedback.rating))).all()
    feedback_counts = {rating: count for rating, count in feedback}

    return {
        "total_sessions": len(sessions),
        "total_messages": len(messages),
        "anonymous_sessions": sum(1 for s in sessions if s.is_anonymous),
        "no_info_replies": len(no_info_rows),
        "no_info_rate": round(len(no_info_rows) / assistant_total, 3) if assistant_total else None,
        "feedback": {"up": feedback_counts.get("up", 0), "down": feedback_counts.get("down", 0)},
    }


async def _export_escalations(db, out: Path) -> dict:
    rows = (await db.execute(select(EscalationRequest).order_by(EscalationRequest.created_at.desc()))).scalars().all()
    data = [{
        "id": str(r.id),
        "session_id": str(r.session_id) if r.session_id else "",
        "user_label": r.user_label or "",
        "contact": r.contact,
        "name": r.name or "",
        "reason": (r.reason or "").replace("\n", " "),
        "status": r.status,
        "attachment_count": len(r.attachments or []),
        "created_at": r.created_at.isoformat(),
    } for r in rows]
    _write_csv(
        out / "escalaciones.csv", data,
        ["id", "session_id", "user_label", "contact", "name", "reason", "status", "attachment_count", "created_at"],
    )
    by_status: dict = {}
    for r in rows:
        by_status[r.status] = by_status.get(r.status, 0) + 1
    result = {"total_escalations": len(rows), "by_status": by_status}

    if settings.storage_provider != "local":
        return result

    # Attachments live under /data/escalations and are tracked by this table, not
    # by DocumentChunk — they are never indexed, so they get their own check.
    # An orphan here means evict_old_attachments() left a file behind (or missed one).
    referenced = {Path(a["url"]).name for r in rows for a in (r.attachments or []) if a.get("url")}
    on_disk = {p.name for p in (Path(settings.local_storage_path) / "escalations").glob("*") if p.is_file()}
    missing = sorted(referenced - on_disk)
    orphaned = sorted(on_disk - referenced)
    _write_csv(out / "adjuntos_escalacion_faltantes.csv", [{"file": f} for f in missing], ["file"])
    _write_csv(out / "adjuntos_escalacion_huerfanos.csv", [{"file": f} for f in orphaned], ["file"])
    result["adjuntos"] = {
        "referenciados": len(referenced),
        "faltantes_en_disco": len(missing),
        "huerfanos_en_disco": len(orphaned),
    }
    return result


async def _export_documents_and_crosscheck(db, out: Path) -> dict:
    rows = (await db.execute(
        select(
            DocumentChunk.file_name, DocumentChunk.source_type, DocumentChunk.gcs_url,
            func.count(DocumentChunk.id), func.min(DocumentChunk.created_at), func.max(DocumentChunk.created_at),
        ).group_by(DocumentChunk.file_name, DocumentChunk.source_type, DocumentChunk.gcs_url)
    )).all()

    doc_rows = [{
        "file_name": file_name,
        "source_type": source_type,
        "path_or_url": gcs_url,
        "chunk_count": count,
        "indexed_at": first_seen.isoformat(),
        "last_chunk_at": last_seen.isoformat(),
    } for file_name, source_type, gcs_url, count, first_seen, last_seen in rows]
    _write_csv(
        out / "documentos_indexados.csv", doc_rows,
        ["file_name", "source_type", "path_or_url", "chunk_count", "indexed_at", "last_chunk_at"],
    )

    result = {"total_distinct_files": len(doc_rows), "total_chunks": sum(d["chunk_count"] for d in doc_rows)}

    if settings.storage_provider != "local":
        result["disk_crosscheck"] = "omitido (storage_provider != local)"
        return result

    base = Path(settings.local_storage_path)
    out_resolved = str(out.resolve())
    # Escalation attachments share the volume but are never indexed — they are
    # audited against escalation_requests.attachments instead.
    escalations_dir = str(base / "escalations")
    disk_files = {
        str(p) for p in base.rglob("*")
        if p.is_file() and not str(p).startswith(out_resolved) and not str(p).startswith(escalations_dir)
    }
    db_paths = {d["path_or_url"] for d in doc_rows}

    # In DB but missing on disk: e.g. deleted straight from the /data volume, or
    # deleted via the admin panel (which only removes DocumentChunk rows, not
    # the underlying file — check this list for that leftover case too).
    chunks_missing_file = sorted(p for p in db_paths if p not in disk_files)
    # On disk but no chunks: upload saved the file but background indexing
    # never finished (crashed, or still queued behind the single-job semaphore).
    files_without_chunks = sorted(p for p in disk_files if p not in db_paths)

    _write_csv(out / "chunks_sin_archivo_en_disco.csv", [{"path": p} for p in chunks_missing_file], ["path"])
    _write_csv(out / "archivos_en_disco_sin_indexar.csv", [{"path": p} for p in files_without_chunks], ["path"])

    result["disk_crosscheck"] = {
        "chunks_sin_archivo_en_disco": len(chunks_missing_file),
        "archivos_en_disco_sin_indexar": len(files_without_chunks),
    }
    return result


async def main(out_dir: str):
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)

    summary = {"generated_at": datetime.now(timezone.utc).isoformat(), "storage_provider": settings.storage_provider}
    async with AsyncSessionLocal() as db:
        summary["conversaciones"] = await _export_conversations(db, out)
        summary["escalaciones"] = await _export_escalations(db, out)
        summary["documentos"] = await _export_documents_and_crosscheck(db, out)

    (out / "resumen.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", default="/audit", help="Directorio de salida (móntalo como volumen)")
    args = parser.parse_args()
    asyncio.run(main(args.out))
