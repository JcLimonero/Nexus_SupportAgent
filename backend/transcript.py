"""The conversation behind a support request, in the two shapes support needs:
plain text (for the notification email) and a PDF (attached to the request).

Both come from the same message list so they can never drift apart. PyMuPDF is
already a dependency (PDF ingestion) and its Story API also *writes* PDFs, so
there's no new package here. Imported as `pymupdf`, not `fitz` — the unit-test
conftest mocks `fitz`, and this module is worth testing for real.
"""
import io
from datetime import timedelta
from html import escape

import pymupdf

# Mexico City. A fixed offset is correct: the country dropped DST in 2022.
_TZ = timedelta(hours=-6)
_ROLE = {"user": "Usuario", "assistant": "Asistente"}


def _stamp(created_at) -> str:
    return (created_at + _TZ).strftime("%d/%m/%Y %H:%M") if created_at else ""


def format_transcript(messages, max_chars: int | None = None) -> str:
    """The conversation as plain text. With max_chars, keeps the most recent
    messages (that's where the problem usually is) and says it trimmed."""
    blocks = [
        f"{_ROLE.get(m.role, m.role)} · {_stamp(m.created_at)}\n{m.content}"
        for m in messages
    ]
    if max_chars is None:
        return "\n\n".join(blocks)

    kept: list[str] = []
    used = 0
    for block in reversed(blocks):
        used += len(block) + 2
        if used > max_chars and kept:
            return "[...] (conversación recortada — completa en el PDF adjunto)\n\n" + "\n\n".join(kept)
        kept.insert(0, block)
    return "\n\n".join(kept)


def render_pdf(path: str, title: str | None, messages) -> None:
    """Write the conversation to `path` as a PDF. Story handles wrapping and
    pagination; base-14 Helvetica covers Spanish accents."""
    parts = [f"<h3>{escape(title or 'Conversación')}</h3>"]
    for m in messages:
        parts.append(
            f"<p><b>{escape(_ROLE.get(m.role, m.role))}</b>"
            f'<span style="font-size:8pt;color:#777777"> · {_stamp(m.created_at)}</span></p>'
            f'<p style="white-space: pre-wrap">{escape(m.content or "")}</p>'
        )
    story = pymupdf.Story(html="".join(parts))
    buf = io.BytesIO()
    writer = pymupdf.DocumentWriter(buf)
    page = pymupdf.paper_rect("letter")
    body = page + (54, 54, -54, -54)
    more = True
    while more:
        device = writer.begin_page(page)
        more, _ = story.place(body)
        story.draw(device)
        writer.end_page()
    writer.close()

    # Story embeds whole fonts: ~120 KB for one page, ~29 KB subsetted. Worth
    # the extra pass — this file is emailed, and EmailJS caps attachments.
    doc = pymupdf.open("pdf", buf)
    doc.subset_fonts()
    doc.save(path, garbage=4, deflate=True)
