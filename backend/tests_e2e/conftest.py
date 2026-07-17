"""Live E2E fixtures — run against the real running stack (no mocks).

Usage (stack must be up: `docker compose up -d`):

    docker compose exec backend python -m pytest tests_e2e/ -v

Everything the suite creates (users, documents, sessions) is deleted on
teardown. A handful of tests cost real Gemini calls (~4 per full run).
"""
import json
import os
import time

import httpx
import pytest

BASE_URL = os.environ.get("E2E_BASE_URL", "http://localhost:8000")
ADMIN_EMAIL = os.environ.get("INITIAL_ADMIN_EMAIL", "admin@nexus.local")
ADMIN_PASSWORD = os.environ.get("INITIAL_ADMIN_PASSWORD", "ChangeMe123!")

# The knowledge doc this suite uploads. The activation code is a fact the LLM
# can only know from this document — asserting on it proves the whole
# upload → chunk → embed → retrieve → answer pipeline.
E2E_DOC_NAME = "e2e_conocimiento.txt"
E2E_FACT_CODE = "NEXUS-E2E-4321"
E2E_DOC_CONTENT = (
    "El módulo Prueba E2E de TotalDealer se activa con el código "
    f"{E2E_FACT_CODE}. Para activarlo, abra el menú Configuración, "
    f"seleccione Módulos y escriba el código {E2E_FACT_CODE} en el campo "
    "de licencia. El módulo Prueba E2E sirve para validar la instalación."
)
E2E_QUESTION = "¿Cuál es el código de activación del módulo Prueba E2E?"
OFF_TOPIC_QUESTION = "¿Cuál es la receta tradicional de la paella valenciana?"
NO_INFO_PREFIX = "No tengo información sobre ese tema"

# Sessions created by tests, deleted by the admin on teardown.
CREATED_SESSION_IDS: list[str] = []


def bearer(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def sse_ask(api: httpx.Client, token: str, message: str, session_id: str | None = None) -> dict:
    """POST /api/chat/stream and return the final `done` event (raises if absent).
    Registers the session for teardown cleanup."""
    done = None
    with api.stream(
        "POST", "/api/chat/stream",
        headers=bearer(token),
        json={"message": message, "session_id": session_id},
        timeout=120,
    ) as resp:
        assert resp.status_code == 200, resp.read().decode()
        for line in resp.iter_lines():
            if not line.startswith("data: "):
                continue
            event = json.loads(line[6:])
            assert "error" not in event, f"stream error: {event}"
            if event.get("done"):
                done = event
    assert done is not None, "stream ended without a done event"
    if done["session_id"] not in CREATED_SESSION_IDS:
        CREATED_SESSION_IDS.append(done["session_id"])
    return done


def wait_for_document(api: httpx.Client, admin_token: str, file_name: str, timeout: float = 120) -> None:
    """Poll the documents list until background indexing publishes the file."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        docs = api.get("/api/admin/documents", headers=bearer(admin_token)).json()
        if any(d["file_name"] == file_name for d in docs):
            return
        time.sleep(2)
    raise AssertionError(f"{file_name} was not indexed within {timeout}s")


@pytest.fixture(scope="session")
def api() -> httpx.Client:
    client = httpx.Client(base_url=BASE_URL, timeout=30)
    try:
        client.get("/health")
    except httpx.ConnectError:
        pytest.exit(f"Stack not reachable at {BASE_URL} — start it with `docker compose up -d`", 1)
    yield client
    client.close()


@pytest.fixture(scope="session")
def admin_token(api: httpx.Client) -> str:
    resp = api.post("/api/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD})
    assert resp.status_code == 200, f"admin login failed: {resp.text}"
    return resp.json()["access_token"]


def _make_user(api: httpx.Client, admin_token: str, email: str) -> dict:
    password = "E2ePass123!"
    # Repeat-safe: remove a leftover from an aborted previous run.
    for u in api.get("/api/users", headers=bearer(admin_token)).json():
        if u["email"] == email:
            api.delete(f"/api/users/{u['id']}", headers=bearer(admin_token))
    resp = api.post(
        "/api/users",
        headers=bearer(admin_token),
        json={"email": email, "password": password, "is_admin": False},
    )
    assert resp.status_code == 201, resp.text
    user = resp.json()
    login = api.post("/api/auth/login", json={"email": email, "password": password})
    assert login.status_code == 200
    return {"id": user["id"], "email": email, "password": password, "token": login.json()["access_token"]}


def _cleanup_user(api: httpx.Client, admin_token: str, user: dict) -> None:
    # Their conversations first (admin cascade), then the account.
    convs = api.get(
        "/api/admin/conversations", params={"user_id": user["id"]}, headers=bearer(admin_token)
    ).json()
    for c in convs:
        api.delete(f"/api/admin/conversations/{c['id']}", headers=bearer(admin_token))
    api.delete(f"/api/users/{user['id']}", headers=bearer(admin_token))


@pytest.fixture(scope="session")
def user_a(api, admin_token) -> dict:
    user = _make_user(api, admin_token, "e2e-user-a@nexus.local")
    yield user
    _cleanup_user(api, admin_token, user)


@pytest.fixture(scope="session")
def user_b(api, admin_token) -> dict:
    user = _make_user(api, admin_token, "e2e-user-b@nexus.local")
    yield user
    _cleanup_user(api, admin_token, user)


@pytest.fixture(scope="session")
def e2e_doc(api, admin_token) -> dict:
    # Repeat-safe: drop a leftover copy so the poll below sees the fresh upload.
    api.delete(f"/api/admin/documents/{E2E_DOC_NAME}", headers=bearer(admin_token))
    resp = api.post(
        "/api/admin/upload",
        headers=bearer(admin_token),
        files={"file": (E2E_DOC_NAME, E2E_DOC_CONTENT.encode(), "text/plain")},
    )
    assert resp.status_code == 200, resp.text
    wait_for_document(api, admin_token, E2E_DOC_NAME)
    yield resp.json()
    api.delete(f"/api/admin/documents/{E2E_DOC_NAME}", headers=bearer(admin_token))


@pytest.fixture(scope="session", autouse=True)
def _cleanup_sessions(api, admin_token):
    yield
    for sid in CREATED_SESSION_IDS:
        api.delete(f"/api/admin/conversations/{sid}", headers=bearer(admin_token))
