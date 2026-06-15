import asyncio

from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from db.models import DocumentChunk
from config import get_settings

settings = get_settings()

# ── Embedding backends ───────────────────────────────────────────────────────
_local_model = None
_vertex_model = None


def _get_local_model():
    global _local_model
    if _local_model is None:
        from sentence_transformers import SentenceTransformer
        _local_model = SentenceTransformer(settings.embedding_model_local)
    return _local_model


def _get_vertex_model():
    global _vertex_model
    if _vertex_model is None:
        import vertexai
        from vertexai.language_models import TextEmbeddingModel
        vertexai.init(project=settings.vertex_ai_project, location=settings.vertex_ai_location)
        _vertex_model = TextEmbeddingModel.from_pretrained(settings.embedding_model_vertexai)
    return _vertex_model


# ── Public embed functions (synchronous — use asyncio.to_thread in async ctx) ─

def embed_text(text: str) -> list[float]:
    """Embed a query string."""
    if settings.embedding_provider == "local":
        return _get_local_model().encode(text, normalize_embeddings=True).tolist()
    from vertexai.language_models import TextEmbeddingInput
    return _get_vertex_model().get_embeddings([TextEmbeddingInput(text, "RETRIEVAL_QUERY")])[0].values


def warm_up() -> None:
    """Force the embedding backend to load at startup.

    The local SentenceTransformer lazy-loads on first use, costing ~6–7s —
    which otherwise lands on the first user after every container start.
    Calling this in the app lifespan moves that cost to boot time.
    """
    embed_text("warm up")


def embed_document(text: str) -> list[float]:
    """Embed a document chunk."""
    if settings.embedding_provider == "local":
        return _get_local_model().encode(text, normalize_embeddings=True).tolist()
    from vertexai.language_models import TextEmbeddingInput
    return _get_vertex_model().get_embeddings([TextEmbeddingInput(text, "RETRIEVAL_DOCUMENT")])[0].values


# ── Search ───────────────────────────────────────────────────────────────────

async def search_chunks(
    db: AsyncSession,
    query: str,
    k: int | None = None,
    embedding: list[float] | None = None,
) -> list[dict]:
    """Embed query (in thread) → cosine search via pgvector (async).

    Pass a pre-computed embedding to skip the embed call.
    """
    if k is None:
        k = settings.max_chunks_retrieved

    query_embedding = embedding if embedding is not None else await asyncio.to_thread(embed_text, query)

    result = await db.execute(
        select(DocumentChunk)
        .order_by(DocumentChunk.embedding.cosine_distance(query_embedding))
        .limit(k)
    )
    return [
        {
            "id": str(r.id),
            "content": r.content,
            "source_type": r.source_type,
            "file_name": r.file_name,
            "gcs_url": r.gcs_url,
            "page_number": r.page_number,
        }
        for r in result.scalars().all()
    ]
