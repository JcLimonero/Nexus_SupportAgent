"""Unit tests for the OCR fallback in ingestion.pdf_processor (phase 26).

fitz is a MagicMock in this suite (see conftest), so these drive
extract_pdf_chunks with hand-built fake pages instead of real PDFs. That is the
point of keeping the threshold decision in a pure `needs_ocr` helper.
"""
from unittest.mock import MagicMock, patch

import pytest

import ingestion.pdf_processor as pp
from ingestion.pdf_processor import needs_ocr, extract_pdf_chunks


# ── The threshold decision ──────────────────────────────────────────────────────

def test_needs_ocr_on_near_empty_page():
    # A page screenshot yields only its header — this is the case OCR exists for.
    assert needs_ocr("14 \n \n • \n • ", min_chars=200) is True


def test_needs_ocr_false_on_text_page():
    assert needs_ocr("x" * 250, min_chars=200) is False


def test_needs_ocr_counts_stripped_length():
    assert needs_ocr("   " + "x" * 10 + "   ", min_chars=20) is True


def test_needs_ocr_boundary_is_exclusive():
    assert needs_ocr("x" * 200, min_chars=200) is False
    assert needs_ocr("x" * 199, min_chars=200) is True


# ── Wiring through extract_pdf_chunks ───────────────────────────────────────────

def _fake_page(plain: str, ocr: str = ""):
    """A page whose get_text() returns `plain`, or `ocr` when given a textpage."""
    page = MagicMock()
    page.get_text.side_effect = lambda textpage=None: ocr if textpage is not None else plain
    return page


def _open_with(pages):
    doc = MagicMock()
    doc.__iter__ = lambda self: iter(pages)
    return doc


@pytest.fixture(autouse=True)
def _reset_ocr_flag():
    """The unavailable-flag is module state; keep tests independent of order."""
    pp._ocr_unavailable = False
    yield
    pp._ocr_unavailable = False


def test_ocr_text_replaces_near_empty_page():
    page = _fake_page("8 \n • \n •", ocr="Importes de entrada: el valor de la unidad con IVA " * 5)
    with patch.object(pp.fitz, "open", return_value=_open_with([page])):
        chunks = extract_pdf_chunks("/tmp/x.pdf", "manual.pdf", "/data/pdfs/x.pdf")
    assert chunks, "la página debería indexarse con el texto recuperado"
    assert "Importes de entrada" in chunks[0]["content"]
    assert chunks[0]["page_number"] == 1


def test_ocr_skipped_when_page_has_real_text():
    page = _fake_page("x" * 500, ocr="NO DEBERIA USARSE")
    with patch.object(pp.fitz, "open", return_value=_open_with([page])):
        chunks = extract_pdf_chunks("/tmp/x.pdf", "manual.pdf", "/data/pdfs/x.pdf")
    assert "NO DEBERIA USARSE" not in chunks[0]["content"]


def test_shorter_ocr_result_is_discarded():
    """OCR can come back near-empty on a genuinely blank page — keep the header."""
    page = _fake_page("Anexo A", ocr="")
    with patch.object(pp.fitz, "open", return_value=_open_with([page])):
        chunks = extract_pdf_chunks("/tmp/x.pdf", "manual.pdf", "/data/pdfs/x.pdf")
    assert chunks[0]["content"] == "Anexo A"


def test_missing_tesseract_degrades_instead_of_failing():
    """An image that predates the OCR change must keep indexing, not crash."""
    page = MagicMock()
    page.get_text.side_effect = lambda textpage=None: "pagina 3"
    page.get_textpage_ocr.side_effect = RuntimeError("tesseract not found")
    with patch.object(pp.fitz, "open", return_value=_open_with([page])):
        chunks = extract_pdf_chunks("/tmp/x.pdf", "manual.pdf", "/data/pdfs/x.pdf")
    assert chunks[0]["content"] == "pagina 3"
    assert pp._ocr_unavailable is True


def test_ocr_attempted_once_after_failure():
    """The unavailable-flag must stop us retrying Tesseract on every page."""
    pages = [
        MagicMock(**{"get_text.side_effect": lambda textpage=None: "p"}) for _ in range(3)
    ]
    for p in pages:
        p.get_textpage_ocr.side_effect = RuntimeError("tesseract not found")
    with patch.object(pp.fitz, "open", return_value=_open_with(pages)):
        extract_pdf_chunks("/tmp/x.pdf", "manual.pdf", "/data/pdfs/x.pdf")
    assert sum(p.get_textpage_ocr.call_count for p in pages) == 1


def test_ocr_disabled_by_config():
    from config import get_settings
    settings = get_settings()
    original = settings.ocr_enabled
    settings.ocr_enabled = False
    try:
        page = _fake_page("3", ocr="texto recuperado por ocr")
        with patch.object(pp.fitz, "open", return_value=_open_with([page])):
            chunks = extract_pdf_chunks("/tmp/x.pdf", "manual.pdf", "/data/pdfs/x.pdf")
        assert chunks[0]["content"] == "3"
        page.get_textpage_ocr.assert_not_called()
    finally:
        settings.ocr_enabled = original
