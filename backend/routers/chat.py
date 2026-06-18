import json as _json
import logging
import uuid
import asyncio
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, distinct

from db.connection import get_db, AsyncSessionLocal
from db.models import ChatSession, ChatMessage, DocumentChunk, MessageFeedback, ResponseCache
from auth.firebase_verify import get_current_user
from auth.local_auth import guest_label
from retrieval.vector_search import search_chunks, embed_text
from retrieval.context_builder import build_context
from llm.gemini_client import ask_gemini, stream_gemini_response

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["chat"])

_CACHE_DISTANCE_THRESHOLD = 0.05  # cosine distance; 0.05 ≈ similarity 0.95


# The exact fallback the LLM emits when the context doesn't answer the question.
# When it fires we must NOT attach document citations (retrieval may still have
# returned loosely-related chunks, which would be misleading as "sources").
_NO_INFO_PREFIX = "No tengo información sobre ese tema"


def _is_no_info(answer: str) -> bool:
    return answer.strip().startswith(_NO_INFO_PREFIX)


def _session_identity(user: dict) -> tuple[bool, str]:
    """(is_anonymous, user_label) for a new session, from the token claims."""
    is_anon = bool(user.get("is_anon"))
    if is_anon:
        return True, guest_label(user["uid"])
    return False, user.get("email") or user["uid"]


async def _lookup_cache(db: AsyncSession, embedding: list[float]) -> ResponseCache | None:
    dist_expr = ResponseCache.question_embedding.cosine_distance(embedding)
    result = await db.execute(
        select(ResponseCache, dist_expr.label("dist"))
        .where(dist_expr <= _CACHE_DISTANCE_THRESHOLD)
        .order_by(dist_expr)
        .limit(1)
    )
    row = result.first()
    return row[0] if row else None


async def _save_to_cache(
    embedding: list[float],
    question: str,
    answer: str,
    sources: dict,
    follow_ups: list[str],
) -> None:
    try:
        async with AsyncSessionLocal() as save_db:
            save_db.add(ResponseCache(
                question_embedding=embedding,
                question_text=question,
                answer=answer,
                sources=sources,
                follow_ups=follow_ups,
            ))
            await save_db.commit()
    except Exception as exc:
        logger.error("Cache save error: %s", exc)


class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=2000)
    session_id: str | None = None


class ChatResponse(BaseModel):
    answer: str
    session_id: str
    pdf_sources: list[dict]
    video_sources: list[dict]
    follow_ups: list[str] = []


@router.post("/chat", response_model=ChatResponse)
async def chat(
    request: ChatRequest,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    user_id = user["uid"]

    # Get or create session
    if request.session_id:
        result = await db.execute(
            select(ChatSession).where(
                ChatSession.id == uuid.UUID(request.session_id),
                ChatSession.user_id == user_id,
            )
        )
        session = result.scalar_one_or_none()
        if not session:
            raise HTTPException(status_code=404, detail="Sesión no encontrada")
    else:
        title = request.message.strip()
        if len(title) > 60:
            title = title[:57] + "..."
        is_anon, label = _session_identity(user)
        session = ChatSession(user_id=user_id, title=title, user_label=label, is_anonymous=is_anon)
        db.add(session)
        await db.flush()

    # Recent history (last N messages for context window)
    result = await db.execute(
        select(ChatMessage)
        .where(ChatMessage.session_id == session.id)
        .order_by(ChatMessage.created_at.desc())
        .limit(6)
    )
    history = [
        {"role": m.role, "content": m.content}
        for m in reversed(result.scalars().all())
    ]

    # Search (embed in thread, DB query async) + build context
    chunks = await search_chunks(db, request.message)
    context, pdf_sources, video_sources = build_context(chunks)

    # Call Gemini (blocking SDK → thread)
    gemini_result = await asyncio.to_thread(ask_gemini, history, request.message, context)
    answer = gemini_result["answer"]
    follow_ups = gemini_result.get("follow_ups", [])

    # Don't cite documents when the model says it has no relevant info.
    if _is_no_info(answer):
        pdf_sources, video_sources = [], []

    # Persist both messages
    db.add(ChatMessage(session_id=session.id, role="user", content=request.message))
    db.add(ChatMessage(
        session_id=session.id,
        role="assistant",
        content=answer,
        sources={"pdfs": pdf_sources, "videos": video_sources},
    ))
    await db.commit()

    return ChatResponse(
        answer=answer,
        session_id=str(session.id),
        pdf_sources=pdf_sources,
        video_sources=video_sources,
        follow_ups=follow_ups,
    )


_NEXUS_MARKER = "NEXUS_FOLLOW_UPS:"
# Hold back just enough to detect a partial marker split across a chunk boundary.
# A fixed-size tail buffer is fragile: long Spanish follow-up arrays (often
# >150 chars) would have their marker start streamed to the client before we
# could strip it. Detecting the marker incrementally and only holding back
# len(marker)-1 chars is both correct for any follow-up length and faster.
_MARKER_HOLD = len(_NEXUS_MARKER) - 1


@router.post("/chat/stream")
async def chat_stream(
    request: ChatRequest,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """SSE endpoint — streams Gemini tokens as they arrive."""
    user_id = user["uid"]

    if request.session_id:
        result = await db.execute(
            select(ChatSession).where(
                ChatSession.id == uuid.UUID(request.session_id),
                ChatSession.user_id == user_id,
            )
        )
        session = result.scalar_one_or_none()
        if not session:
            raise HTTPException(status_code=404, detail="Sesión no encontrada")
    else:
        title = request.message.strip()
        if len(title) > 60:
            title = title[:57] + "..."
        is_anon, label = _session_identity(user)
        session = ChatSession(user_id=user_id, title=title, user_label=label, is_anonymous=is_anon)
        db.add(session)
        await db.flush()
        await db.commit()

    result = await db.execute(
        select(ChatMessage)
        .where(ChatMessage.session_id == session.id)
        .order_by(ChatMessage.created_at.desc())
        .limit(6)
    )
    history = [
        {"role": m.role, "content": m.content}
        for m in reversed(result.scalars().all())
    ]

    # Embed once — reused for cache lookup and doc search
    question_embedding = await asyncio.to_thread(embed_text, request.message)

    # ── Cache check ────────────────────────────────────────────────────────────
    cached = await _lookup_cache(db, question_embedding)

    session_id_str = str(session.id)
    user_message = request.message

    if cached:
        cached.hit_count += 1
        cached.last_used_at = datetime.utcnow()
        try:
            await db.commit()
        except Exception as exc:
            logger.error("Cache hit update error: %s", exc)

        async def generate_cached():
            assistant_msg_id = uuid.uuid4()
            try:
                async with AsyncSessionLocal() as save_db:
                    save_db.add(ChatMessage(
                        session_id=uuid.UUID(session_id_str),
                        role="user",
                        content=user_message,
                    ))
                    save_db.add(ChatMessage(
                        id=assistant_msg_id,
                        session_id=uuid.UUID(session_id_str),
                        role="assistant",
                        content=cached.answer,
                        sources=cached.sources,
                    ))
                    await save_db.commit()
            except Exception as exc:
                logger.error("Cached message save error: %s", exc)

            yield f"data: {_json.dumps({'token': cached.answer})}\n\n"
            yield f"data: {_json.dumps({'done': True, 'session_id': session_id_str, 'message_id': str(assistant_msg_id), 'answer': cached.answer, 'pdf_sources': cached.sources.get('pdfs', []), 'video_sources': cached.sources.get('videos', []), 'follow_ups': cached.follow_ups, 'from_cache': True})}\n\n"

        return StreamingResponse(
            generate_cached(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    # ── Cache miss — full pipeline ─────────────────────────────────────────────
    chunks = await search_chunks(db, request.message, embedding=question_embedding)
    context, pdf_sources, video_sources = build_context(chunks)

    async def generate():
        accumulated = ""
        yielded = 0       # chars of `accumulated` already streamed to the client
        marker_idx = -1   # position of the NEXUS_FOLLOW_UPS marker once seen

        try:
            async for delta in stream_gemini_response(history, user_message, context):
                accumulated += delta
                if marker_idx < 0:
                    marker_idx = accumulated.find(_NEXUS_MARKER)
                if marker_idx >= 0:
                    # Marker reached — stream only the answer up to it, then stop;
                    # everything after the marker is follow-ups, never streamed.
                    if yielded < marker_idx:
                        yield f"data: {_json.dumps({'token': accumulated[yielded:marker_idx]})}\n\n"
                        yielded = marker_idx
                else:
                    # Safe to stream all but the last few chars (a partial marker
                    # could be split across this and the next chunk).
                    safe = len(accumulated) - _MARKER_HOLD
                    if safe > yielded:
                        yield f"data: {_json.dumps({'token': accumulated[yielded:safe]})}\n\n"
                        yielded = safe
        except Exception as exc:
            logger.error("Gemini stream error: %s", exc)
            yield f"data: {_json.dumps({'error': 'Error al procesar la respuesta'})}\n\n"
            return

        # Finalize — split answer / follow-ups on the marker.
        answer = accumulated
        follow_ups_list: list[str] = []
        if marker_idx < 0:
            marker_idx = accumulated.find(_NEXUS_MARKER)
        if marker_idx >= 0:
            answer = accumulated[:marker_idx].rstrip()
            try:
                follow_ups_list = _json.loads(accumulated[marker_idx + len(_NEXUS_MARKER):].strip())
                if not isinstance(follow_ups_list, list):
                    follow_ups_list = []
            except _json.JSONDecodeError:
                follow_ups_list = []
            # Flush any answer chars we were still holding back before the marker.
            if yielded < marker_idx:
                yield f"data: {_json.dumps({'token': accumulated[yielded:marker_idx]})}\n\n"
        else:
            # No marker — flush whatever tail we held back.
            if yielded < len(accumulated):
                yield f"data: {_json.dumps({'token': accumulated[yielded:]})}\n\n"

        # Don't cite documents when the model reports no relevant info.
        final_pdfs, final_videos = ([], []) if _is_no_info(answer) else (pdf_sources, video_sources)

        # Persist messages in a fresh session to avoid closed-connection issues
        assistant_msg_id = uuid.uuid4()
        try:
            async with AsyncSessionLocal() as save_db:
                save_db.add(ChatMessage(
                    session_id=uuid.UUID(session_id_str),
                    role="user",
                    content=user_message,
                ))
                save_db.add(ChatMessage(
                    id=assistant_msg_id,
                    session_id=uuid.UUID(session_id_str),
                    role="assistant",
                    content=answer,
                    sources={"pdfs": final_pdfs, "videos": final_videos},
                ))
                await save_db.commit()
        except Exception as exc:
            logger.error("DB save error after stream: %s", exc)

        # Save to semantic cache for future identical/similar questions
        await _save_to_cache(
            question_embedding,
            user_message,
            answer,
            {"pdfs": final_pdfs, "videos": final_videos},
            follow_ups_list,
        )

        yield f"data: {_json.dumps({'done': True, 'session_id': session_id_str, 'message_id': str(assistant_msg_id), 'answer': answer, 'pdf_sources': final_pdfs, 'video_sources': final_videos, 'follow_ups': follow_ups_list})}\n\n"

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# Generic fallback shown only if generation fails or the KB is empty — these are
# content-style questions, never file names.
_FALLBACK_SUGGESTIONS = [
    {"label": "Configuración inicial", "prompt": "¿Cómo configuro el sistema por primera vez?"},
    {"label": "Resolver un caso", "prompt": "¿Cómo resuelvo un caso de soporte paso a paso?"},
    {"label": "Facturación", "prompt": "¿Cómo emito una factura en el sistema?"},
]

# Suggestions are content-derived (via Gemini) and identical for everyone, so we
# cache them. Invalidated on document upload/delete; otherwise refreshed by TTL.
_SUGGESTION_TTL = 1800  # 30 min
_suggestion_cache: dict = {"value": None, "expiry": 0.0}
_suggestion_lock = asyncio.Lock()


def clear_suggestions_cache() -> None:
    _suggestion_cache["value"] = None
    _suggestion_cache["expiry"] = 0.0


@router.get("/suggestions")
async def get_suggestions(
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Return content-based suggested questions (cached), never file names."""
    import time
    from llm.gemini_client import generate_suggestion_questions

    now = time.monotonic()
    if _suggestion_cache["value"] is not None and now < _suggestion_cache["expiry"]:
        return _suggestion_cache["value"]

    async with _suggestion_lock:
        # Re-check after acquiring the lock (another request may have filled it).
        now = time.monotonic()
        if _suggestion_cache["value"] is not None and now < _suggestion_cache["expiry"]:
            return _suggestion_cache["value"]

        # One representative content snippet per document, capped.
        result = await db.execute(
            select(DocumentChunk.file_name, DocumentChunk.source_type, DocumentChunk.content)
            .distinct(DocumentChunk.file_name)
            .order_by(DocumentChunk.file_name, DocumentChunk.chunk_index)
            .limit(12)
        )
        samples = [
            {"file_name": r.file_name, "source_type": r.source_type, "content": r.content}
            for r in result.all()
        ]

        suggestions = _FALLBACK_SUGGESTIONS
        if samples:
            try:
                generated = await asyncio.to_thread(generate_suggestion_questions, samples, 6)
                if generated:
                    suggestions = generated
            except Exception as exc:
                logger.error("Suggestion generation failed, using fallback: %s", exc)

        _suggestion_cache["value"] = suggestions
        _suggestion_cache["expiry"] = time.monotonic() + _SUGGESTION_TTL
        return suggestions


@router.get("/sessions")
async def get_sessions(
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    result = await db.execute(
        select(ChatSession)
        .where(ChatSession.user_id == user["uid"])
        .order_by(ChatSession.updated_at.desc())
        .limit(20)
    )
    return [
        {"id": str(s.id), "title": s.title, "created_at": s.created_at.isoformat()}
        for s in result.scalars().all()
    ]


class RenameRequest(BaseModel):
    title: str = Field(min_length=1, max_length=120)


@router.patch("/sessions/{session_id}")
async def rename_session(
    session_id: str,
    body: RenameRequest,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    result = await db.execute(
        select(ChatSession).where(
            ChatSession.id == uuid.UUID(session_id),
            ChatSession.user_id == user["uid"],
        )
    )
    session = result.scalar_one_or_none()
    if not session:
        raise HTTPException(status_code=404, detail="Sesión no encontrada")
    session.title = body.title.strip()
    await db.commit()
    return {"id": session_id, "title": session.title}


@router.delete("/sessions/{session_id}", status_code=204)
async def delete_session(
    session_id: str,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    result = await db.execute(
        select(ChatSession).where(
            ChatSession.id == uuid.UUID(session_id),
            ChatSession.user_id == user["uid"],
        )
    )
    session = result.scalar_one_or_none()
    if not session:
        raise HTTPException(status_code=404, detail="Sesión no encontrada")
    # Delete messages first (no cascade configured)
    await db.execute(
        select(ChatMessage).where(ChatMessage.session_id == session.id)
    )
    from sqlalchemy import delete as sql_delete
    await db.execute(sql_delete(ChatMessage).where(ChatMessage.session_id == session.id))
    await db.delete(session)
    await db.commit()


@router.get("/sessions/{session_id}/messages")
async def get_session_messages(
    session_id: str,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    result = await db.execute(
        select(ChatMessage)
        .join(ChatSession)
        .where(
            ChatSession.id == uuid.UUID(session_id),
            ChatSession.user_id == user["uid"],
        )
        .order_by(ChatMessage.created_at)
    )
    return [
        {
            "id": str(m.id),
            "role": m.role,
            "content": m.content,
            "sources": m.sources,
            "created_at": m.created_at.isoformat(),
        }
        for m in result.scalars().all()
    ]


class FeedbackRequest(BaseModel):
    rating: str = Field(pattern="^(up|down)$")


@router.post("/messages/{message_id}/feedback", status_code=201)
async def submit_feedback(
    message_id: str,
    body: FeedbackRequest,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    try:
        msg_uuid = uuid.UUID(message_id)
    except ValueError:
        raise HTTPException(status_code=422, detail="ID de mensaje inválido")

    result = await db.execute(
        select(ChatMessage)
        .join(ChatSession)
        .where(
            ChatMessage.id == msg_uuid,
            ChatSession.user_id == user["uid"],
        )
    )
    if not result.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="Mensaje no encontrado")

    existing = await db.execute(
        select(MessageFeedback).where(
            MessageFeedback.message_id == msg_uuid,
            MessageFeedback.user_id == user["uid"],
        )
    )
    feedback = existing.scalar_one_or_none()
    if feedback:
        feedback.rating = body.rating
    else:
        db.add(MessageFeedback(message_id=msg_uuid, user_id=user["uid"], rating=body.rating))
    await db.commit()
    return {"message_id": message_id, "rating": body.rating}


@router.get("/admin/feedback")
async def get_feedback(
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    if not user.get("is_admin"):
        raise HTTPException(status_code=403, detail="Acceso denegado")
    result = await db.execute(
        select(MessageFeedback).order_by(MessageFeedback.created_at.desc()).limit(200)
    )
    return [
        {
            "id": str(f.id),
            "message_id": str(f.message_id),
            "user_id": f.user_id,
            "rating": f.rating,
            "created_at": f.created_at.isoformat(),
        }
        for f in result.scalars().all()
    ]
