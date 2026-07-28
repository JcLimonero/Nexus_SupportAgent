"""The conversation behind a support request, in the two shapes support needs:
plain text (for the notification email) and a PDF (attached to the request).

Both come from the same message list so they can never drift apart. PyMuPDF is
already a dependency (PDF ingestion) and its Story API also *writes* PDFs, so
there's no new package here. Imported as `pymupdf`, not `fitz` — the unit-test
conftest mocks `fitz`, and this module is worth testing for real.

The assistant answers in Markdown (** bold **, `code`, - lists, # headings).
Raw, it reads as literal asterisks. We render that small subset ourselves — the
bot only ever emits these few things, so a handful of regexes beats pulling in a
Markdown dependency: as HTML for the PDF (Story renders it), stripped to clean
text for the email body (which stays a plain preview; the PDF is the full copy).
"""
import io
import re
from datetime import timedelta
from html import escape

import pymupdf

# Mexico City. A fixed offset is correct: the country dropped DST in 2022.
_TZ = timedelta(hours=-6)
_ROLE = {"user": "Usuario", "assistant": "Asistente"}

# The Markdown subset the assistant emits.
_CODE = re.compile(r"`([^`\n]+)`")
_BOLD = re.compile(r"\*\*(.+?)\*\*")
_ITALIC = re.compile(r"\*([^*\n]+)\*|_([^_\n]+)_")
_BULLET = re.compile(r"^\s*[*\-]\s+(.*)")
_NUMBER = re.compile(r"^\s*(\d+)\.\s+(.*)")
_HEADING = re.compile(r"^\s*#{1,6}\s+(.*)")


def _stamp(created_at) -> str:
    return (created_at + _TZ).strftime("%d/%m/%Y %H:%M") if created_at else ""


def _inline_html(text: str) -> str:
    """Escape HTML, then render inline Markdown (bold, italic, code). Code spans
    are stashed before escaping so ** or _ inside them stay literal."""
    codes: list[str] = []
    text = _CODE.sub(lambda m: (codes.append(m.group(1)), f"\x00{len(codes) - 1}\x00")[1], text)
    text = escape(text)
    text = _BOLD.sub(r"<b>\1</b>", text)
    text = _ITALIC.sub(lambda m: f"<i>{m.group(1) or m.group(2)}</i>", text)
    return re.sub(
        r"\x00(\d+)\x00",
        lambda m: f'<code style="font-family:monospace;font-size:9pt">{escape(codes[int(m.group(1))])}</code>',
        text,
    )


def _md_to_html(content: str) -> str:
    """The assistant's Markdown as the HTML subset Story understands: paragraphs,
    bullet/numbered lists, headings, and inline bold/italic/code."""
    out: list[str] = []
    para: list[str] = []
    list_tag: str | None = None

    def flush_para():
        if para:
            out.append(f'<p>{"<br/>".join(_inline_html(l) for l in para)}</p>')
            para.clear()

    def close_list():
        nonlocal list_tag
        if list_tag:
            out.append(f"</{list_tag}>")
            list_tag = None

    for line in content.split("\n"):
        if not line.strip():
            flush_para(); close_list(); continue
        heading = _HEADING.match(line)
        bullet = _BULLET.match(line)
        number = _NUMBER.match(line)
        if heading:
            flush_para(); close_list()
            out.append(f"<p><b>{_inline_html(heading.group(1))}</b></p>")
        elif bullet or number:
            flush_para()
            want = "ul" if bullet else "ol"
            if list_tag != want:
                close_list()
                out.append(f"<{want}>")
                list_tag = want
            item = bullet.group(1) if bullet else number.group(2)
            out.append(f"<li>{_inline_html(item)}</li>")
        else:
            close_list()
            para.append(line)
    flush_para(); close_list()
    return "".join(out)


def _strip_md(content: str) -> str:
    """The same content as clean plain text: drop bold/italic/code markers and
    turn list bullets into • so the email body reads without stray asterisks."""
    lines = []
    for line in content.split("\n"):
        line = _HEADING.sub(r"\1", line)
        line = _BULLET.sub(r"• \1", line)
        lines.append(line)
    text = "\n".join(lines)
    text = _CODE.sub(r"\1", text)
    text = _BOLD.sub(r"\1", text)
    text = _ITALIC.sub(lambda m: m.group(1) or m.group(2), text)
    return text


def format_transcript(messages, max_chars: int | None = None) -> str:
    """The conversation as plain text. With max_chars, keeps the most recent
    messages (that's where the problem usually is) and says it trimmed."""
    blocks = [
        f"{_ROLE.get(m.role, m.role)} · {_stamp(m.created_at)}\n{_strip_md(m.content or '')}"
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
            f"{_md_to_html(m.content or '')}"
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
