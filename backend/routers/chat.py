import json as _json
import logging
import re
import uuid
import asyncio

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, distinct

from db.connection import get_db, AsyncSessionLocal
from db.models import ChatSession, ChatMessage, DocumentChunk, MessageFeedback
from auth.firebase_verify import get_current_user
from retrieval.vector_search import search_chunks
from retrieval.context_builder import build_context
from llm.gemini_client import ask_gemini, stream_gemini_response

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["chat"])


class ChatRequest(BaseModel):
    message: str = Field(min_length=1)
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
        session = ChatSession(user_id=user_id, title=title)
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
_TAIL_BUFFER = 380  # hold back enough tail to catch the marker + JSON array


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
        session = ChatSession(user_id=user_id, title=title)
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

    chunks = await search_chunks(db, request.message)
    context, pdf_sources, video_sources = build_context(chunks)

    # Capture plain values — session may not be accessible after db closes
    session_id_str = str(session.id)
    user_message = request.message

    async def generate():
        accumulated = ""
        pending = ""  # tail buffer to intercept the NEXUS_FOLLOW_UPS line

        try:
            async for delta in stream_gemini_response(history, user_message, context):
                accumulated += delta
                pending += delta
                safe_len = max(0, len(pending) - _TAIL_BUFFER)
                if safe_len > 0:
                    yield f"data: {_json.dumps({'token': pending[:safe_len]})}\n\n"
                    pending = pending[safe_len:]
        except Exception as exc:
            logger.error("Gemini stream error: %s", exc)
            yield f"data: {_json.dumps({'error': 'Error al procesar la respuesta'})}\n\n"
            return

        # Flush tail — strip NEXUS_FOLLOW_UPS marker before sending to client
        answer = accumulated
        follow_ups_list: list[str] = []
        marker_idx = pending.find(_NEXUS_MARKER)
        if marker_idx >= 0:
            before = pending[:marker_idx].rstrip()
            if before:
                yield f"data: {_json.dumps({'token': before})}\n\n"
            try:
                follow_ups_list = _json.loads(pending[marker_idx + len(_NEXUS_MARKER):].strip())
                if not isinstance(follow_ups_list, list):
                    follow_ups_list = []
            except _json.JSONDecodeError:
                follow_ups_list = []
            full_idx = accumulated.rfind(_NEXUS_MARKER)
            if full_idx >= 0:
                answer = accumulated[:full_idx].rstrip()
        else:
            if pending:
                yield f"data: {_json.dumps({'token': pending})}\n\n"

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
                    sources={"pdfs": pdf_sources, "videos": video_sources},
                ))
                await save_db.commit()
        except Exception as exc:
            logger.error("DB save error after stream: %s", exc)

        yield f"data: {_json.dumps({'done': True, 'session_id': session_id_str, 'message_id': str(assistant_msg_id), 'answer': answer, 'pdf_sources': pdf_sources, 'video_sources': video_sources, 'follow_ups': follow_ups_list})}\n\n"

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


_CLEAN_PATTERNS = [
    r"\bVersion\s+[\d.]+\b",
    r"\bVerion\s+[\d.]+\b",
    r"\.docx\b",
    r"\.(pdf|mp4)\b",
    r"\bManual de (Usuario |Configuraci[oó]n |[Cc]onfguracion )",
    r"\bManual de\b",
    r"^Configuraci[oó]n\s+",  # strip leading "Configuración" from video titles
]


def _derive_suggestion(file_name: str, source_type: str) -> dict:
    label = file_name
    for pat in _CLEAN_PATTERNS:
        label = re.sub(pat, "", label, flags=re.IGNORECASE)
    label = label.strip().strip("-").strip()
    # Truncate display label
    display = label if len(label) <= 48 else label[:45] + "..."
    low = label.lower()
    if "configur" in low or "autorespuesta" in low or "blueservice" in low or "ads" in low:
        prompt = f"¿Cómo configuro {label}?"
    elif source_type == "video":
        prompt = f"Explícame el proceso de {label.lower()}"
    else:
        prompt = f"¿Cómo funciona {label}?"
    return {"label": display, "prompt": prompt}


@router.get("/suggestions")
async def get_suggestions(
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Return up to 6 suggested questions derived from indexed document names."""
    result = await db.execute(
        select(DocumentChunk.file_name, DocumentChunk.source_type)
        .distinct(DocumentChunk.file_name)
        .limit(6)
    )
    rows = result.all()
    return [_derive_suggestion(row.file_name, row.source_type) for row in rows]


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
