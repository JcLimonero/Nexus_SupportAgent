import logging

import fitz  # PyMuPDF

from ingestion.chunker import chunk_text
from config import get_settings

settings = get_settings()
logger = logging.getLogger(__name__)

# Tesseract is an optional system dependency. If the image predates the OCR
# change, every page would log the same failure — warn once and move on.
_ocr_unavailable = False


def needs_ocr(page_text: str, min_chars: int) -> bool:
    """True when a page yielded too little text to be its real content.

    Split out from the extraction loop so the threshold logic is testable
    without Tesseract or a real PDF (the unit-test conftest mocks fitz).
    """
    return len(page_text.strip()) < min_chars


def _ocr_page(page) -> str:
    """Re-read a page through Tesseract. Returns "" if OCR is unavailable."""
    global _ocr_unavailable
    if _ocr_unavailable:
        return ""
    try:
        textpage = page.get_textpage_ocr(
            language=settings.ocr_language,
            dpi=settings.ocr_dpi,
            full=True,
            tessdata=settings.ocr_tessdata_path or None,
        )
        return page.get_text(textpage=textpage)
    except Exception as exc:
        # Missing binary, missing language pack, or a page Tesseract chokes on.
        # Never fail the upload over it — the page just stays as it was.
        _ocr_unavailable = True
        logger.warning(
            "OCR no disponible (%s). Las páginas escaneadas se indexarán sin su "
            "contenido. Instala tesseract-ocr y el paquete de idioma '%s'.",
            exc, settings.ocr_language,
        )
        return ""


def extract_pdf_chunks(file_path: str, file_name: str, gcs_url: str) -> list[dict]:
    doc = fitz.open(file_path)
    all_chunks = []
    chunk_index = 0
    ocr_pages = 0

    for page_num, page in enumerate(doc, start=1):
        page_text = page.get_text()

        if settings.ocr_enabled and needs_ocr(page_text, settings.ocr_min_chars):
            ocr_text = _ocr_page(page)
            # Keep whichever reading is longer: OCR can come back empty on a
            # genuinely blank page, and we'd rather not lose a real header.
            if len(ocr_text.strip()) > len(page_text.strip()):
                page_text = ocr_text
                ocr_pages += 1

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

    if ocr_pages:
        logger.info("%s: %d página(s) recuperadas por OCR", file_name, ocr_pages)

    doc.close()
    return all_chunks
