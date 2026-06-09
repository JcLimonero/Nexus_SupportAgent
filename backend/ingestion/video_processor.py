import subprocess
import tempfile
from pathlib import Path

from faster_whisper import WhisperModel

from ingestion.chunker import chunk_text
from config import get_settings

settings = get_settings()
_whisper_model = None


def _get_whisper() -> WhisperModel:
    global _whisper_model
    if _whisper_model is None:
        # int8 keeps CPU memory low; "base" is fast enough for support docs
        _whisper_model = WhisperModel("base", device="cpu", compute_type="int8")
    return _whisper_model


def _extract_audio(video_path: str, audio_path: str):
    subprocess.run(
        ["ffmpeg", "-i", video_path, "-vn", "-acodec", "pcm_s16le",
         "-ar", "16000", "-ac", "1", "-y", audio_path],
        check=True,
        capture_output=True,
    )


def extract_video_chunks(video_path: str, file_name: str, gcs_url: str) -> list[dict]:
    model = _get_whisper()

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        audio_path = tmp.name

    try:
        _extract_audio(video_path, audio_path)
        segments, _ = model.transcribe(audio_path, language="es")
        transcript = " ".join(seg.text.strip() for seg in segments)
    finally:
        Path(audio_path).unlink(missing_ok=True)

    return [
        {
            "content": chunk,
            "source_type": "video",
            "file_name": file_name,
            "gcs_url": gcs_url,
            "page_number": None,
            "chunk_index": i,
        }
        for i, chunk in enumerate(chunk_text(transcript, settings.chunk_size, settings.chunk_overlap))
    ]
