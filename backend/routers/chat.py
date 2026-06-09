import uuid
import asyncio

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from db.connection import get_db
from db.models import ChatSession, ChatMessage
from auth.firebase_verify import get_current_user
from retrieval.vector_search import search_chunks
from retrieval.context_builder import build_context
from llm.gemini_client import ask_gemini

router = APIRouter(prefix="/api", tags=["chat"])


class ChatRequest(BaseModel):
    message: str = Field(min_length=1)
    session_id: str | None = None


class ChatResponse(BaseModel):
    answer: str
    session_id: str
    pdf_sources: list[dict]
    video_sources: list[dict]


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
        session = ChatSession(user_id=user_id)
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
    answer = await asyncio.to_thread(ask_gemini, history, request.message, context)

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
    )


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
        {"id": str(s.id), "created_at": s.created_at.isoformat()}
        for s in result.scalars().all()
    ]


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
