"""Unit tests for ingestion.document_processor text extraction + chunking."""
import pytest

from ingestion.document_processor import extract_document_chunks
from ingestion.chunker import chunk_timed_segments


# ── Timestamped transcript chunking (video/audio deep links) ────────────────────

def test_chunk_timed_segments_tags_start_time():
    segments = [(0.0, "uno dos tres"), (5.5, "cuatro cinco seis"), (10.0, "siete")]
    chunks = chunk_timed_segments(segments, chunk_size=3, overlap=0)
    assert [c["start_time"] for c in chunks] == [0.0, 5.5, 10.0]
    assert chunks[0]["content"] == "uno dos tres"
    assert chunks[1]["content"] == "cuatro cinco seis"


def test_chunk_timed_segments_first_word_time_wins_with_overlap():
    # words: a,b,c,d @0.0 then e,f,g,h @8.0; size 4 / overlap 2 → windows every 2 words
    segments = [(0.0, "a b c d"), (8.0, "e f g h")]
    chunks = chunk_timed_segments(segments, chunk_size=4, overlap=2)
    assert [c["start_time"] for c in chunks] == [0.0, 0.0, 8.0, 8.0]
    assert chunks[0]["content"] == "a b c d"


def test_chunk_timed_segments_empty():
    assert chunk_timed_segments([], chunk_size=3, overlap=0) == []


def _write(tmp_path, name: str, data: bytes):
    p = tmp_path / name
    p.write_bytes(data)
    return str(p)


# ── Plain text ──────────────────────────────────────────────────────────────────

def test_txt_extraction(tmp_path):
    path = _write(tmp_path, "n.txt", "Hola mundo de prueba".encode("utf-8"))
    chunks = extract_document_chunks(path, "n.txt", "/data/txts/n.txt", ".txt")
    assert len(chunks) == 1
    assert chunks[0]["source_type"] == "txt"
    assert chunks[0]["page_number"] is None
    assert "Hola mundo" in chunks[0]["content"]
    assert chunks[0]["file_name"] == "n.txt"
    assert chunks[0]["gcs_url"] == "/data/txts/n.txt"


def test_md_extraction(tmp_path):
    path = _write(tmp_path, "doc.md", "# Título\n\nContenido del manual.".encode("utf-8"))
    chunks = extract_document_chunks(path, "doc.md", "/data/mds/doc.md", ".md")
    assert chunks[0]["source_type"] == "md"
    assert "Contenido del manual" in chunks[0]["content"]


def test_empty_text_yields_no_chunks(tmp_path):
    path = _write(tmp_path, "empty.txt", b"   \n  ")
    chunks = extract_document_chunks(path, "empty.txt", "/data/txts/empty.txt", ".txt")
    assert chunks == []


def test_txt_tolerates_non_utf8_bytes(tmp_path):
    path = _write(tmp_path, "latin.txt", "café".encode("latin-1"))
    chunks = extract_document_chunks(path, "latin.txt", "/data/txts/latin.txt", ".txt")
    assert len(chunks) == 1  # decoded with errors="replace", does not raise


# ── CSV ──────────────────────────────────────────────────────────────────────────

def test_csv_extraction_with_header(tmp_path):
    path = _write(tmp_path, "data.csv", b"nombre,rol\nAna,admin\nLuis,user\n")
    chunks = extract_document_chunks(path, "data.csv", "/data/csvs/data.csv", ".csv")
    assert chunks[0]["source_type"] == "csv"
    content = chunks[0]["content"]
    assert "nombre: Ana" in content
    assert "rol: admin" in content


# ── Unsupported ──────────────────────────────────────────────────────────────────

def test_unsupported_extension_raises(tmp_path):
    path = _write(tmp_path, "x.xyz", b"data")
    with pytest.raises(ValueError):
        extract_document_chunks(path, "x.xyz", "/data/x.xyz", ".xyz")


# ── DOCX / PPTX (skip if optional libs absent) ──────────────────────────────────

def test_docx_extraction(tmp_path):
    docx = pytest.importorskip("docx")
    path = str(tmp_path / "m.docx")
    d = docx.Document()
    d.add_paragraph("Primer párrafo del manual.")
    d.add_paragraph("Segundo párrafo con instrucciones.")
    d.save(path)

    chunks = extract_document_chunks(path, "m.docx", "/data/docxs/m.docx", ".docx")
    assert chunks[0]["source_type"] == "docx"
    assert chunks[0]["page_number"] is None
    joined = " ".join(c["content"] for c in chunks)
    assert "Primer párrafo" in joined
    assert "Segundo párrafo" in joined


def test_pptx_extraction_carries_slide_numbers(tmp_path):
    pptx = pytest.importorskip("pptx")
    path = str(tmp_path / "deck.pptx")
    prs = pptx.Presentation()
    layout = prs.slide_layouts[5]  # title-only, has a title placeholder
    for i in (1, 2):
        slide = prs.slides.add_slide(layout)
        slide.shapes.title.text = f"Diapositiva {i}"
    prs.save(path)

    chunks = extract_document_chunks(path, "deck.pptx", "/data/pptxs/deck.pptx", ".pptx")
    assert all(c["source_type"] == "pptx" for c in chunks)
    slide_numbers = {c["page_number"] for c in chunks}
    assert slide_numbers == {1, 2}
