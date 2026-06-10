def build_context(chunks: list[dict]) -> tuple[str, list[dict], list[dict]]:
    """Returns (context_text, pdf_sources, video_sources)."""
    context_parts = []
    pdf_sources: list[dict] = []
    video_sources: list[dict] = []
    seen_pdfs: set[str] = set()
    seen_videos: set[str] = set()

    for i, chunk in enumerate(chunks, start=1):
        context_parts.append(f"[Fragmento {i}]\n{chunk['content']}")

        if chunk["source_type"] == "pdf":
            key = f"{chunk['file_name']}:{chunk['page_number']}"
            if key not in seen_pdfs:
                seen_pdfs.add(key)
                pdf_sources.append({
                    "chunk_id": chunk.get("id", ""),
                    "file_name": chunk["file_name"],
                    "page_number": chunk["page_number"],
                    "gcs_url": chunk["gcs_url"],
                })
        elif chunk["source_type"] == "video":
            if chunk["gcs_url"] not in seen_videos:
                seen_videos.add(chunk["gcs_url"])
                video_sources.append({
                    "file_name": chunk["file_name"],
                    "gcs_url": chunk["gcs_url"],
                })

    return "\n\n".join(context_parts), pdf_sources, video_sources
