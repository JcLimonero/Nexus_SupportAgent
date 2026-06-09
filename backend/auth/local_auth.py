"""
Local dev auth — simple JWT, no Firebase needed.
Any email/password combo works; the token identifies the user by email.
"""
from datetime import datetime, timedelta, timezone

import jwt
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from config import get_settings

settings = get_settings()
router = APIRouter(prefix="/api/auth", tags=["auth"])


class LoginRequest(BaseModel):
    email: str
    password: str  # accepted as-is in local dev — not validated against a real store


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    email: str


def create_token(email: str) -> str:
    payload = {
        "uid": email,          # matches the "uid" field the rest of the app reads
        "email": email,
        "exp": datetime.now(timezone.utc) + timedelta(hours=settings.local_jwt_expire_hours),
    }
    return jwt.encode(payload, settings.local_jwt_secret, algorithm="HS256")


def verify_local_token(token: str) -> dict:
    try:
        return jwt.decode(token, settings.local_jwt_secret, algorithms=["HS256"])
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expirado")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Token inválido")


@router.post("/login", response_model=TokenResponse)
async def login(body: LoginRequest):
    token = create_token(body.email)
    return TokenResponse(access_token=token, email=body.email)
