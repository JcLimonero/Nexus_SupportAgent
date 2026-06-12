from fastapi import Security
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials

from auth.local_auth import verify_local_token

security = HTTPBearer()


async def get_current_user(creds: HTTPAuthorizationCredentials = Security(security)) -> dict:
    return verify_local_token(creds.credentials)
