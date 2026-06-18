import uuid
from datetime import datetime, timedelta, timezone

import jwt
from fastapi import APIRouter, Depends, HTTPException
from passlib.context import CryptContext
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from config import get_settings
from db.connection import get_db
from db.models import User

settings = get_settings()
router = APIRouter(prefix="/api/auth", tags=["auth"])
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


# ── Password helpers ─────────────────────────────────────────────────────────

def hash_password(plain: str) -> str:
    return pwd_context.hash(plain)


def verify_password(plain: str, hashed: str) -> bool:
    return pwd_context.verify(plain, hashed)


# ── Token helpers ────────────────────────────────────────────────────────────

def create_token(user: User) -> str:
    payload = {
        "uid": str(user.id),
        "email": user.email,
        "is_admin": user.is_admin,
        "exp": datetime.now(timezone.utc) + timedelta(hours=settings.local_jwt_expire_hours),
    }
    return jwt.encode(payload, settings.local_jwt_secret, algorithm="HS256")


def create_guest_token() -> tuple[str, str, str]:
    """Mint a short-lived anonymous token. Returns (token, uid, label)."""
    guest_uid = f"anon:{uuid.uuid4().hex}"
    label = guest_label(guest_uid)
    payload = {
        "uid": guest_uid,
        "email": label,        # human label so the UI has something to show
        "is_admin": False,
        "is_anon": True,
        "exp": datetime.now(timezone.utc) + timedelta(hours=settings.guest_jwt_expire_hours),
    }
    token = jwt.encode(payload, settings.local_jwt_secret, algorithm="HS256")
    return token, guest_uid, label


def guest_label(guest_uid: str) -> str:
    """'anon:ab12cd...' → 'Invitado #ab12'. Stable per guest session."""
    suffix = guest_uid.split(":", 1)[-1][:4] if ":" in guest_uid else guest_uid[:4]
    return f"Invitado #{suffix}"


def verify_local_token(token: str) -> dict:
    try:
        return jwt.decode(token, settings.local_jwt_secret, algorithms=["HS256"])
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expirado")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Token inválido")


# ── Schemas ──────────────────────────────────────────────────────────────────

class LoginRequest(BaseModel):
    email: str
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    email: str
    is_admin: bool
    is_anon: bool = False


# ── Routes ───────────────────────────────────────────────────────────────────

@router.post("/login", response_model=TokenResponse)
async def login(body: LoginRequest, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(User).where(User.email == body.email))
    user = result.scalar_one_or_none()

    if not user or not user.is_active or not verify_password(body.password, user.hashed_password):
        raise HTTPException(status_code=401, detail="Credenciales incorrectas")

    return TokenResponse(
        access_token=create_token(user),
        email=user.email,
        is_admin=user.is_admin,
    )


@router.post("/guest", response_model=TokenResponse)
async def guest():
    """Issue an anonymous session token for users without an account."""
    if not settings.allow_anonymous:
        raise HTTPException(status_code=403, detail="El acceso de invitados está deshabilitado")
    token, _uid, label = create_guest_token()
    return TokenResponse(access_token=token, email=label, is_admin=False, is_anon=True)
