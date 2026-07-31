import uuid

from fastapi import Security, Depends, HTTPException
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from auth.local_auth import verify_local_token
from db.connection import get_db
from db.models import User

security = HTTPBearer()


async def load_account(claims: dict, db: AsyncSession) -> User | None:
    """Live DB row for a registered user's token. Split into its own function so
    the per-request re-check is a one-line stub in the unit tests (the E2E suite
    hits the real DB)."""
    return (
        await db.execute(select(User).where(User.id == uuid.UUID(claims["uid"])))
    ).scalar_one_or_none()


async def get_current_user(
    creds: HTTPAuthorizationCredentials = Security(security),
    db: AsyncSession = Depends(get_db),
) -> dict:
    claims = verify_local_token(creds.credentials)
    # Guests have no DB row; their token is self-contained and short-lived.
    if claims.get("is_anon"):
        return claims
    # Re-check registered users every request so deactivating or demoting an
    # account takes effect immediately instead of surviving the token's ~30h
    # lifetime. The DB — not the (stale/forgeable) claim — is the source of
    # truth for is_admin.
    account = await load_account(claims, db)
    if account is None or not account.is_active:
        raise HTTPException(status_code=401, detail="Cuenta inactiva o inexistente")
    claims["is_admin"] = account.is_admin
    return claims
