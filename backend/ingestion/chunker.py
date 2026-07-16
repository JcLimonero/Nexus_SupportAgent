def chunk_text(text: str, chunk_size: int = 500, overlap: int = 50) -> list[str]:
    """Split text into overlapping word-count chunks."""
    words = text.split()
    chunks = []
    start = 0
    while start < len(words):
        chunk = " ".join(words[start : start + chunk_size])
        if chunk.strip():
            chunks.append(chunk)
        start += chunk_size - overlap
    return chunks


def chunk_timed_segments(
    segments: list[tuple[float, str]], chunk_size: int = 500, overlap: int = 50
) -> list[dict]:
    """Chunk transcript (start_seconds, text) segments the same way as chunk_text,
    but tag each chunk with the start time of its first word so the player can
    jump straight to it.

    Each word inherits its segment's start time (~1-2s granularity from Whisper,
    enough to land on the answer). We then slide the same word window as chunk_text.
    """
    timed_words = [
        (word, start) for start, text in segments for word in text.split()
    ]
    chunks: list[dict] = []
    start = 0
    while start < len(timed_words):
        window = timed_words[start : start + chunk_size]
        content = " ".join(word for word, _ in window)
        if content.strip():
            chunks.append({"content": content, "start_time": window[0][1]})
        start += chunk_size - overlap
    return chunks
