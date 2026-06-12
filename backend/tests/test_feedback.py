import uuid
import pytest
from unittest.mock import AsyncMock, MagicMock

from tests.conftest import make_jwt


def _make_feedback_db(message=None, existing_feedback=None):
    async def _override():
        session = AsyncMock()

        def _execute_side_effect(query):
            result = MagicMock()
            result.scalar_one_or_none.return_value = message if message is not None else None
            if existing_feedback is not None:
                result.scalar_one_or_none.side_effect = [message, existing_feedback]
            return AsyncMock(return_value=result)()

        session.execute = _execute_side_effect
        session.commit = AsyncMock()
        session.add = MagicMock()
        yield session

    return _override


def _stub_message():
    msg = MagicMock()
    msg.id = uuid.uuid4()
    return msg


@pytest.mark.anyio
async def test_feedback_requires_auth(client):
    msg_id = str(uuid.uuid4())
    response = await client.post(f"/api/messages/{msg_id}/feedback", json={"rating": "up"})
    assert response.status_code == 403


@pytest.mark.anyio
async def test_feedback_rejects_invalid_rating(client):
    from db.connection import get_db
    from main import app

    app.dependency_overrides[get_db] = _make_feedback_db(message=_stub_message())
    token = make_jwt()
    msg_id = str(uuid.uuid4())
    response = await client.post(
        f"/api/messages/{msg_id}/feedback",
        json={"rating": "meh"},
        headers={"Authorization": f"Bearer {token}"},
    )
    app.dependency_overrides.clear()
    assert response.status_code == 422


@pytest.mark.anyio
async def test_feedback_rejects_invalid_uuid(client):
    from db.connection import get_db
    from main import app

    app.dependency_overrides[get_db] = _make_feedback_db()
    token = make_jwt()
    response = await client.post(
        "/api/messages/not-a-uuid/feedback",
        json={"rating": "up"},
        headers={"Authorization": f"Bearer {token}"},
    )
    app.dependency_overrides.clear()
    assert response.status_code == 422


@pytest.mark.anyio
async def test_feedback_404_when_message_not_found(client):
    from db.connection import get_db
    from main import app

    app.dependency_overrides[get_db] = _make_feedback_db(message=None)
    token = make_jwt()
    msg_id = str(uuid.uuid4())
    response = await client.post(
        f"/api/messages/{msg_id}/feedback",
        json={"rating": "up"},
        headers={"Authorization": f"Bearer {token}"},
    )
    app.dependency_overrides.clear()
    assert response.status_code == 404


@pytest.mark.anyio
async def test_feedback_up_created(client):
    from db.connection import get_db
    from main import app

    msg = _stub_message()
    app.dependency_overrides[get_db] = _make_feedback_db(message=msg, existing_feedback=None)
    token = make_jwt()
    response = await client.post(
        f"/api/messages/{msg.id}/feedback",
        json={"rating": "up"},
        headers={"Authorization": f"Bearer {token}"},
    )
    app.dependency_overrides.clear()
    assert response.status_code == 201
    data = response.json()
    assert data["rating"] == "up"
    assert data["message_id"] == str(msg.id)


@pytest.mark.anyio
async def test_feedback_down_created(client):
    from db.connection import get_db
    from main import app

    msg = _stub_message()
    app.dependency_overrides[get_db] = _make_feedback_db(message=msg, existing_feedback=None)
    token = make_jwt()
    response = await client.post(
        f"/api/messages/{msg.id}/feedback",
        json={"rating": "down"},
        headers={"Authorization": f"Bearer {token}"},
    )
    app.dependency_overrides.clear()
    assert response.status_code == 201
    assert response.json()["rating"] == "down"


@pytest.mark.anyio
async def test_admin_feedback_requires_admin(client):
    token = make_jwt(is_admin=False)
    response = await client.get(
        "/api/admin/feedback",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 403


@pytest.mark.anyio
async def test_admin_feedback_returns_list(client):
    from db.connection import get_db
    from main import app
    import datetime

    feedback_obj = MagicMock()
    feedback_obj.id = uuid.uuid4()
    feedback_obj.message_id = uuid.uuid4()
    feedback_obj.user_id = "user-123"
    feedback_obj.rating = "up"
    feedback_obj.created_at = datetime.datetime(2026, 1, 1, 12, 0, 0)

    async def _override():
        session = AsyncMock()
        result = MagicMock()
        result.scalars.return_value.all.return_value = [feedback_obj]
        session.execute = AsyncMock(return_value=result)
        yield session

    app.dependency_overrides[get_db] = _override
    token = make_jwt(is_admin=True)
    response = await client.get(
        "/api/admin/feedback",
        headers={"Authorization": f"Bearer {token}"},
    )
    app.dependency_overrides.clear()
    assert response.status_code == 200
    data = response.json()
    assert len(data) == 1
    assert data[0]["rating"] == "up"
    assert data[0]["message_id"] == str(feedback_obj.message_id)
