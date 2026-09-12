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


def embed_documents(texts: list[str]) -> list[list[float]]:
    """Embed many document chunks in batched model calls.

    One call per chunk pays model/API overhead N times; batching turns a
    100-chunk video into a handful of calls.
    """
    if not texts:
        return []
    if settings.embedding_provider == "local":
        return _get_local_model().encode(texts, normalize_embeddings=True).tolist()
    from vertexai.language_models import TextEmbeddingInput
    model = _get_vertex_model()
    out: list[list[float]] = []
    # 20 chunks of ~500 words stays well under Vertex's per-request token limit.
    for i in range(0, len(texts), 20):
        batch = [TextEmbeddingInput(t, "RETRIEVAL_DOCUMENT") for t in texts[i : i + 20]]
        out.extend(e.values for e in model.get_embeddings(batch))
    return out


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

    dist = DocumentChunk.embedding.cosine_distance(query_embedding)
    result = await db.execute(
        select(DocumentChunk, dist.label("distance"))
        # Drop chunks that aren't even loosely related — off-topic questions
        # otherwise ship the 4 nearest-but-irrelevant chunks to the LLM.
        .where(dist <= settings.retrieval_max_distance)
        .order_by(dist)
        .limit(k)
    )
    rows = result.all()

    # Optional relative cutoff, applied after the absolute one (disabled by
    # default — see config.retrieval_relative_delta for the measured trade-off).
    delta = settings.retrieval_relative_delta
    if delta > 0 and rows:
        best = rows[0].distance
        rows = [r for r in rows if r.distance <= best + delta]

    return [
        {
            "id": str(r.DocumentChunk.id),
            "content": r.DocumentChunk.content,
            "source_type": r.DocumentChunk.source_type,
            "file_name": r.DocumentChunk.file_name,
            "gcs_url": r.DocumentChunk.gcs_url,
            "page_number": r.DocumentChunk.page_number,
            "start_time": r.DocumentChunk.start_time,
            "distance": float(r.distance),
        }
        for r in rows
    ]
