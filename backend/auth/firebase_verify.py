import os

from fastapi import HTTPException, Security
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials

from config import get_settings

settings = get_settings()
security = HTTPBearer()

# ── Firebase (production) ────────────────────────────────────────────────────
_firebase_app = None


def _get_firebase_app():
    global _firebase_app
    if _firebase_app is None:
        import firebase_admin
        from firebase_admin import credentials
        cred = (
            credentials.Certificate("/app/service-account.json")
            if os.path.exists("/app/service-account.json")
            else credentials.ApplicationDefault()
        )
        _firebase_app = firebase_admin.initialize_app(cred, {"projectId": settings.firebase_project_id})
    return _firebase_app


def _verify_firebase(token: str) -> dict:
    from firebase_admin import auth
    _get_firebase_app()
    try:
        return auth.verify_id_token(token)
    except Exception:
        raise HTTPException(status_code=401, detail="Token inválido o expirado")


# ── Local JWT (development) ──────────────────────────────────────────────────
def _verify_local(token: str) -> dict:
    from auth.local_auth import verify_local_token
    return verify_local_token(token)


# ── Unified dependency ───────────────────────────────────────────────────────
async def get_current_user(creds: HTTPAuthorizationCredentials = Security(security)) -> dict:
    if settings.auth_provider == "local":
        return _verify_local(creds.credentials)
    return _verify_firebase(creds.credentials)
