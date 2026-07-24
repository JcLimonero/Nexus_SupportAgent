from datetime import datetime
from types import SimpleNamespace

import pymupdf

from transcript import format_transcript, render_pdf


def _msg(role, content, hour=20):
    # Stored UTC; 20:00 UTC → 14:00 in Mexico City.
    return SimpleNamespace(role=role, content=content, created_at=datetime(2026, 7, 24, hour, 30))


_CHAT = [
    _msg("user", "¿Cómo facturo un pedido de mostrador?"),
    _msg("assistant", "Entra a Ventas → Facturación y selecciona el pedido.", 21),
]


def test_format_transcript_labels_roles_and_local_time():
    text = format_transcript(_CHAT)
    assert "Usuario · 24/07/2026 14:30" in text
    assert "Asistente · 24/07/2026 15:30" in text
    assert "¿Cómo facturo un pedido de mostrador?" in text


def test_format_transcript_keeps_the_most_recent_messages():
    chat = [_msg("user", f"mensaje número {i} " + "x" * 200) for i in range(20)]
    text = format_transcript(chat, max_chars=800)
    assert "conversación recortada" in text
    assert "mensaje número 19" in text      # the end is where the problem is
    assert "mensaje número 0 " not in text
    assert len(text) < 1200


def test_render_pdf_round_trips_the_conversation(tmp_path):
    out = str(tmp_path / "conversacion.pdf")
    render_pdf(out, "Facturación de mostrador", _CHAT)

    doc = pymupdf.open(out)
    text = "".join(page.get_text() for page in doc)
    assert "Facturación de mostrador" in text          # title, accents intact
    assert "¿Cómo facturo un pedido de mostrador?" in text
    assert "Asistente" in text and "Usuario" in text
    # Fonts are subsetted — the file gets emailed and EmailJS caps attachments.
    assert (tmp_path / "conversacion.pdf").stat().st_size < 60_000


def test_render_pdf_paginates_a_long_conversation(tmp_path):
    out = str(tmp_path / "larga.pdf")
    render_pdf(out, None, [_msg("user", "línea de prueba " * 40) for _ in range(30)])
    assert pymupdf.open(out).page_count > 1


def test_render_pdf_escapes_html(tmp_path):
    out = str(tmp_path / "html.pdf")
    render_pdf(out, None, [_msg("user", "<b>no soy negritas</b>")])
    assert "<b>no soy negritas</b>" in pymupdf.open(out).load_page(0).get_text()
