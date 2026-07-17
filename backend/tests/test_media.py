"""Security tests for the signed media streaming endpoints."""
import time
from pathlib import Path

import pytest

from tests.conftest import make_jwt
from routers.media import _sig


@pytest.mark.anyio
async def test_sign_requires_auth(client):
    response = await client.post("/api/media/sign", json={"gcs_url": "/data/videos/x.mp4"})
    assert response.status_code in (401, 403)


@pytest.mark.anyio
async def test_sign_rejects_non_storage_url(client, auth_token):
    response = await client.post(
        "/api/media/sign",
        json={"gcs_url": "https://evil.example.com/x.mp4"},
        headers={"Authorization": f"Bearer {auth_token}"},
    )
    assert response.status_code == 400


@pytest.mark.anyio
async def test_sign_returns_signed_stream_url(client, auth_token):
    response = await client.post(
        "/api/media/sign",
        json={"gcs_url": "/data/videos/demo.mp4"},
        headers={"Authorization": f"Bearer {auth_token}"},
    )
    assert response.status_code == 200
    url = response.json()["url"]
    assert url.startswith("/api/media/stream/videos/demo.mp4?exp=")
    assert "sig=" in url


@pytest.mark.anyio
async def test_stream_rejects_bad_signature(client):
    exp = int(time.time()) + 600
    response = await client.get(f"/api/media/stream/videos/demo.mp4?exp={exp}&sig=deadbeef")
    assert response.status_code == 403


@pytest.mark.anyio
async def test_stream_rejects_expired_link(client):
    exp = int(time.time()) - 10
    sig = _sig("videos/demo.mp4", exp)
    response = await client.get(f"/api/media/stream/videos/demo.mp4?exp={exp}&sig={sig}")
    assert response.status_code == 403


@pytest.mark.anyio
async def test_stream_rejects_path_traversal_even_with_valid_signature(client):
    # Even a correctly signed path must not escape the storage root.
    path = "../etc/passwd"
    exp = int(time.time()) + 600
    sig = _sig(path, exp)
    response = await client.get(f"/api/media/stream/{path}?exp={exp}&sig={sig}")
    assert response.status_code in (403, 404)


@pytest.mark.anyio
async def test_stream_serves_file_with_valid_signature(client, tmp_path, monkeypatch):
    import routers.media as media
    monkeypatch.setattr(media.settings, "local_storage_path", str(tmp_path))
    (tmp_path / "videos").mkdir()
    (tmp_path / "videos" / "demo.mp4").write_bytes(b"0123456789")

    exp = int(time.time()) + 600
    sig = _sig("videos/demo.mp4", exp)
    response = await client.get(f"/api/media/stream/videos/demo.mp4?exp={exp}&sig={sig}")
    assert response.status_code == 200
    assert response.content == b"0123456789"

    # Range requests must work — that's what lets the player seek.
    response = await client.get(
        f"/api/media/stream/videos/demo.mp4?exp={exp}&sig={sig}",
        headers={"Range": "bytes=2-5"},
    )
    assert response.status_code == 206
    assert response.content == b"2345"
