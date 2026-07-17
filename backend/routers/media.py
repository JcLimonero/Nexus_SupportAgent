"""Short-lived signed URLs for direct media/document streaming.

The old flow downloaded the whole file as a blob before the player could
start. Here /sign (authenticated) mints a URL the <video>/<audio> tag can use
directly, so the browser streams with Range requests and can seek instantly:

  - local storage → /api/media/stream/... guarded by an HMAC signature
    (no Authorization header needed, which is what makes native streaming work)
  - GCS → a V4 signed URL, so the bucket never needs to be public
"""
import hashlib
import hmac
import os
import time
from pathlib import Path
from urllib.parse import quote, unquote

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

from auth.firebase_verify import get_current_user
from config import get_settings

settings = get_settings()
router = APIRouter(prefix="/api/media", tags=["media"])

_SIGN_TTL = 3600  # 1 h — enough to watch a full training video

# Content-type when serving from local storage (kept in sync with uploads).
_SERVE_MIME = {
    ".pdf":  "application/pdf",
    ".mp4":  "video/mp4",
    ".mp3":  "audio/mpeg",
    ".m4a":  "audio/mp4",
    ".wav":  "audio/wav",
    ".ogg":  "audio/ogg",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".txt":  "text/plain; charset=utf-8",
    ".md":   "text/markdown; charset=utf-8",
    ".csv":  "text/csv; charset=utf-8",
}


def _sig(path: str, exp: int) -> str:
    return hmac.new(
        settings.local_jwt_secret.encode(), f"{path}:{exp}".encode(), hashlib.sha256
    ).hexdigest()


class SignRequest(BaseModel):
    gcs_url: str


@router.post("/sign")
async def sign_media(body: SignRequest, _: dict = Depends(get_current_user)):
    if settings.storage_provider == "gcs":
        prefix = f"https://storage.googleapis.com/{settings.gcs_bucket_name}/"
        if not body.gcs_url.startswith(prefix):
            raise HTTPException(status_code=400, detail="URL de archivo inválida")
        from datetime import timedelta
        from google.cloud import storage as gcs
        blob = gcs.Client().bucket(settings.gcs_bucket_name).blob(
            unquote(body.gcs_url[len(prefix):])
        )
        return {"url": blob.generate_signed_url(
            version="v4", expiration=timedelta(seconds=_SIGN_TTL)
        )}

    if not body.gcs_url.startswith("/data/"):
        raise HTTPException(status_code=400, detail="URL de archivo inválida")
    rel = body.gcs_url[len("/data/"):]
    exp = int(time.time()) + _SIGN_TTL
    encoded = "/".join(quote(seg) for seg in rel.split("/"))
    return {"url": f"/api/media/stream/{encoded}?exp={exp}&sig={_sig(rel, exp)}"}


@router.get("/stream/{file_path:path}")
async def stream_media(file_path: str, exp: int, sig: str):
    """No auth header — authorized by the HMAC signature minted by /sign."""
    if time.time() > exp:
        raise HTTPException(status_code=403, detail="Enlace expirado")
    if not hmac.compare_digest(sig, _sig(file_path, exp)):
        raise HTTPException(status_code=403, detail="Firma inválida")
    base = Path(settings.local_storage_path).resolve()
    target = (base / file_path).resolve()
    if not str(target).startswith(str(base) + os.sep):
        raise HTTPException(status_code=403, detail="Acceso denegado")
    if not target.is_file():
        raise HTTPException(status_code=404, detail="Archivo no encontrado")
    media = _SERVE_MIME.get(target.suffix.lower(), "application/octet-stream")
    # FileResponse honors Range requests → the player can seek without a full download.
    return FileResponse(str(target), media_type=media)
