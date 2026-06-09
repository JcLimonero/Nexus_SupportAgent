import fitz  # PyMuPDF

from ingestion.chunker import chunk_text
from config import get_settings

settings = get_settings()


def extract_pdf_chunks(file_path: str, file_name: str, gcs_url: str) -> list[dict]:
    doc = fitz.open(file_path)
    all_chunks = []
    chunk_index = 0

    for page_num, page in enumerate(doc, start=1):
        page_text = page.get_text()
        if not page_text.strip():
            continue
        for chunk in chunk_text(page_text, settings.chunk_size, settings.chunk_overlap):
            all_chunks.append({
                "content": chunk,
                "source_type": "pdf",
                "file_name": file_name,
                "gcs_url": gcs_url,
                "page_number": page_num,
                "chunk_index": chunk_index,
            })
            chunk_index += 1

    doc.close()
    return all_chunks
