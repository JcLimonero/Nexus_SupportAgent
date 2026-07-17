import subprocess
import tempfile
from pathlib import Path

from faster_whisper import WhisperModel

from ingestion.chunker import chunk_timed_segments
from config import get_settings

settings = get_settings()
_whisper_model = None


def _get_whisper() -> WhisperModel:
    global _whisper_model
    if _whisper_model is None:
        # int8 keeps CPU memory low; "base" is fast enough for support docs
        _whisper_model = WhisperModel("base", device="cpu", compute_type="int8")
    return _whisper_model


def _extract_audio(media_path: str, audio_path: str):
    # -vn drops any video track; works for both video containers and audio files
    # (ffmpeg decodes mp3/m4a/wav/ogg the same way it does an mp4 soundtrack).
    subprocess.run(
        ["ffmpeg", "-i", media_path, "-vn", "-acodec", "pcm_s16le",
         "-ar", "16000", "-ac", "1", "-y", audio_path],
        check=True,
        capture_output=True,
    )


def extract_media_chunks(
    media_path: str, file_name: str, gcs_url: str, source_type: str = "video"
) -> list[dict]:
    """Transcribe a video or audio file and return timestamped chunks.

    Both source types share one path: normalize to 16 kHz mono WAV, transcribe
    with Whisper, then chunk on segment boundaries so each chunk carries the
    start time the player can seek to. `source_type` is "video" or "audio".
    """
    model = _get_whisper()

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        audio_path = tmp.name

    try:
        _extract_audio(media_path, audio_path)
        # vad_filter skips silence (training videos pause a lot); beam_size=1
        # (greedy) is ~2-3x faster than the default beam of 5 with negligible
        # quality loss for RAG transcripts.
        segments, _ = model.transcribe(
            audio_path, language="es", vad_filter=True, beam_size=1
        )
        timed_segments = [(float(seg.start), seg.text.strip()) for seg in segments]
    finally:
        Path(audio_path).unlink(missing_ok=True)

    return [
        {
            "content": chunk["content"],
            "source_type": source_type,
            "file_name": file_name,
            "gcs_url": gcs_url,
            "page_number": None,
            "chunk_index": i,
            "start_time": chunk["start_time"],
        }
        for i, chunk in enumerate(
            chunk_timed_segments(timed_segments, settings.chunk_size, settings.chunk_overlap)
        )
    ]
