"""Full-stack E2E: every CRUD surface + the complete RAG flow, no mocks.

Tests run in file order — later sections reuse state from earlier ones via S,
and the rate-limit test runs last because it poisons the login window.
"""
import time

import pytest

from tests_e2e.conftest import (
    CREATED_SESSION_IDS,
    E2E_DOC_NAME,
    E2E_FACT_CODE,
    E2E_QUESTION,
    NO_INFO_PREFIX,
    OFF_TOPIC_QUESTION,
    bearer,
    sse_ask,
    wait_for_document,
)

# Cross-test state (session ids, message ids, share tokens).
S: dict = {}


# ── 1. Health & surface ───────────────────────────────────────────────────────

def test_health(api):
    resp = api.get("/health")
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"


def test_docs_available_in_local_dev(api):
    # /docs is enabled locally and must be disabled in production (nginx 404s
    # it there as well); this suite runs against the local stack.
    assert api.get("/docs").status_code == 200


def test_unknown_route_404(api):
    assert api.get("/api/no-such-route").status_code == 404


# ── 2. Auth ───────────────────────────────────────────────────────────────────

def test_login_wrong_password(api):
    resp = api.post("/api/auth/login", json={"email": "admin@nexus.local", "password": "wrong-password"})
    assert resp.status_code == 401


def test_login_unknown_email_same_response(api):
    resp = api.post("/api/auth/login", json={"email": "nobody@nexus.local", "password": "whatever123"})
    assert resp.status_code == 401
    # Same detail for unknown email and wrong password — no account enumeration.
    assert resp.json()["detail"] == "Credenciales incorrectas"


def test_protected_route_requires_token(api):
    assert api.get("/api/sessions").status_code in (401, 403)


def test_protected_route_rejects_garbage_token(api):
    resp = api.get("/api/sessions", headers=bearer("not-a-jwt"))
    assert resp.status_code == 401


def test_guest_token(api):
    resp = api.post("/api/auth/guest")
    assert resp.status_code == 200
    body = resp.json()
    assert body["is_anon"] is True
    assert body["email"].startswith("Invitado #")
    S["guest_token"] = body["access_token"]


# ── 3. Users CRUD ─────────────────────────────────────────────────────────────

TEMP_EMAIL = "e2e-temp@nexus.local"
TEMP_PASSWORD = "TempPass123!"


def test_users_require_admin(api, user_a):
    assert api.get("/api/users").status_code in (401, 403)
    assert api.get("/api/users", headers=bearer(user_a["token"])).status_code == 403
    assert api.post(
        "/api/users", headers=bearer(user_a["token"]),
        json={"email": "x@x.com", "password": "Password1!"},
    ).status_code == 403


def test_user_create_and_login(api, admin_token):
    # Repeat-safe: remove a leftover temp user from an aborted run.
    for u in api.get("/api/users", headers=bearer(admin_token)).json():
        if u["email"] == TEMP_EMAIL:
            api.delete(f"/api/users/{u['id']}", headers=bearer(admin_token))

    resp = api.post(
        "/api/users", headers=bearer(admin_token),
        json={"email": TEMP_EMAIL, "password": TEMP_PASSWORD, "is_admin": False},
    )
    assert resp.status_code == 201
    S["temp_user_id"] = resp.json()["id"]

    emails = [u["email"] for u in api.get("/api/users", headers=bearer(admin_token)).json()]
    assert TEMP_EMAIL in emails

    login = api.post("/api/auth/login", json={"email": TEMP_EMAIL, "password": TEMP_PASSWORD})
    assert login.status_code == 200


def test_user_create_duplicate_email(api, admin_token):
    resp = api.post(
        "/api/users", headers=bearer(admin_token),
        json={"email": TEMP_EMAIL, "password": TEMP_PASSWORD},
    )
    assert resp.status_code == 409


def test_user_create_weak_password(api, admin_token):
    resp = api.post(
        "/api/users", headers=bearer(admin_token),
        json={"email": "weak@nexus.local", "password": "short"},
    )
    assert resp.status_code == 422


def test_user_deactivate_blocks_login(api, admin_token):
    uid = S["temp_user_id"]
    resp = api.patch(f"/api/users/{uid}", headers=bearer(admin_token), json={"is_active": False})
    assert resp.status_code == 200 and resp.json()["is_active"] is False

    login = api.post("/api/auth/login", json={"email": TEMP_EMAIL, "password": TEMP_PASSWORD})
    assert login.status_code == 401  # inactive → same 401 as bad credentials

    resp = api.patch(f"/api/users/{uid}", headers=bearer(admin_token), json={"is_active": True})
    assert resp.status_code == 200 and resp.json()["is_active"] is True


def test_user_promote_admin(api, admin_token):
    uid = S["temp_user_id"]
    assert api.patch(f"/api/users/{uid}", headers=bearer(admin_token), json={"is_admin": True}).status_code == 200
    # A fresh token carries the new claim and opens admin routes.
    token = api.post("/api/auth/login", json={"email": TEMP_EMAIL, "password": TEMP_PASSWORD}).json()["access_token"]
    assert api.get("/api/admin/stats", headers=bearer(token)).status_code == 200
    assert api.patch(f"/api/users/{uid}", headers=bearer(admin_token), json={"is_admin": False}).status_code == 200


def test_user_password_change(api, admin_token):
    uid = S["temp_user_id"]
    new_password = "NuevoPass456!"
    assert api.patch(f"/api/users/{uid}", headers=bearer(admin_token), json={"password": new_password}).status_code == 200
    assert api.post("/api/auth/login", json={"email": TEMP_EMAIL, "password": TEMP_PASSWORD}).status_code == 401
    assert api.post("/api/auth/login", json={"email": TEMP_EMAIL, "password": new_password}).status_code == 200


def test_admin_cannot_delete_self(api, admin_token):
    admin = next(u for u in api.get("/api/users", headers=bearer(admin_token)).json() if u["email"] == "admin@nexus.local")
    resp = api.delete(f"/api/users/{admin['id']}", headers=bearer(admin_token))
    assert resp.status_code == 400


def test_user_delete(api, admin_token):
    uid = S["temp_user_id"]
    assert api.delete(f"/api/users/{uid}", headers=bearer(admin_token)).status_code == 204
    assert api.delete(f"/api/users/{uid}", headers=bearer(admin_token)).status_code == 404
    assert api.post("/api/auth/login", json={"email": TEMP_EMAIL, "password": "NuevoPass456!"}).status_code == 401


# ── 4. Document upload validation ─────────────────────────────────────────────

PNG_BYTES = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64


def test_upload_requires_admin(api, user_a):
    files = {"file": ("x.txt", b"hola", "text/plain")}
    assert api.post("/api/admin/upload", files=files).status_code in (401, 403)
    assert api.post("/api/admin/upload", headers=bearer(user_a["token"]), files=files).status_code == 403


def test_upload_rejects_disallowed_extension(api, admin_token):
    resp = api.post(
        "/api/admin/upload", headers=bearer(admin_token),
        files={"file": ("malware.exe", b"MZ....", "application/octet-stream")},
    )
    assert resp.status_code == 400


def test_upload_rejects_binary_disguised_as_text(api, admin_token):
    resp = api.post(
        "/api/admin/upload", headers=bearer(admin_token),
        files={"file": ("fake.txt", PNG_BYTES, "text/plain")},
    )
    assert resp.status_code == 400


def test_upload_rejects_spoofed_pdf(api, admin_token):
    resp = api.post(
        "/api/admin/upload", headers=bearer(admin_token),
        files={"file": ("fake.pdf", PNG_BYTES, "application/pdf")},
    )
    assert resp.status_code == 400


def test_documents_list_requires_admin(api, user_a):
    assert api.get("/api/admin/documents", headers=bearer(user_a["token"])).status_code == 403


# ── 5. Chat + sessions CRUD (uses the uploaded knowledge doc) ────────────────

def test_rag_answer_cites_uploaded_doc(api, user_a, e2e_doc):
    done = sse_ask(api, user_a["token"], E2E_QUESTION)
    assert E2E_FACT_CODE in done["answer"], done["answer"]
    assert any(s["file_name"] == E2E_DOC_NAME for s in done["pdf_sources"])
    S["session1"] = done["session_id"]
    S["message1"] = done["message_id"]
    S["chunk_id"] = done["pdf_sources"][0]["chunk_id"]


def test_excerpt_shows_cited_chunk(api, user_a):
    resp = api.get(f"/api/admin/documents/excerpt/{S['chunk_id']}", headers=bearer(user_a["token"]))
    assert resp.status_code == 200
    assert E2E_FACT_CODE in resp.json()["content"]
    assert api.get("/api/admin/documents/excerpt/not-a-uuid", headers=bearer(user_a["token"])).status_code == 422


def test_repeat_question_hits_semantic_cache(api, user_a):
    done = sse_ask(api, user_a["token"], E2E_QUESTION)
    assert done.get("from_cache") is True
    assert E2E_FACT_CODE in done["answer"]


def test_off_topic_returns_no_info_without_citations(api, user_a):
    done = sse_ask(api, user_a["token"], OFF_TOPIC_QUESTION)
    assert done["answer"].startswith(NO_INFO_PREFIX), done["answer"]
    assert done["pdf_sources"] == [] and done["video_sources"] == []
    S["session_off_topic"] = done["session_id"]


def test_non_stream_chat_endpoint(api, user_a):
    resp = api.post(
        "/api/chat", headers=bearer(user_a["token"]),
        json={"message": E2E_QUESTION}, timeout=120,
    )
    assert resp.status_code == 200
    body = resp.json()
    assert E2E_FACT_CODE in body["answer"]
    CREATED_SESSION_IDS.append(body["session_id"])


def test_session_messages_history(api, user_a):
    resp = api.get(f"/api/sessions/{S['session1']}/messages", headers=bearer(user_a["token"]))
    assert resp.status_code == 200
    msgs = resp.json()
    assert [m["role"] for m in msgs[:2]] == ["user", "assistant"]
    assert msgs[0]["content"] == E2E_QUESTION


def test_continuing_session_moves_it_to_top(api, user_a):
    # session1 is older than session_off_topic; continuing it must reorder.
    sse_ask(api, user_a["token"], E2E_QUESTION, session_id=S["session1"])
    sessions = api.get("/api/sessions", headers=bearer(user_a["token"])).json()
    assert sessions[0]["id"] == S["session1"]


def test_session_rename(api, user_a):
    resp = api.patch(
        f"/api/sessions/{S['session1']}", headers=bearer(user_a["token"]),
        json={"title": "Renombrada por E2E"},
    )
    assert resp.status_code == 200
    titles = {s["id"]: s["title"] for s in api.get("/api/sessions", headers=bearer(user_a["token"])).json()}
    assert titles[S["session1"]] == "Renombrada por E2E"


def test_session_rename_validation(api, user_a):
    assert api.patch(
        f"/api/sessions/{S['session1']}", headers=bearer(user_a["token"]), json={"title": ""}
    ).status_code == 422
    assert api.patch(
        "/api/sessions/not-a-uuid", headers=bearer(user_a["token"]), json={"title": "x"}
    ).status_code == 422


def test_session_ownership_enforced(api, user_b):
    # User B must not see, rename, or delete user A's session — 404, not 403,
    # so existence isn't leaked.
    hdrs = bearer(user_b["token"])
    sid = S["session1"]
    assert api.get(f"/api/sessions/{sid}/messages", headers=hdrs).json() == []
    assert api.patch(f"/api/sessions/{sid}", headers=hdrs, json={"title": "hack"}).status_code == 404
    assert api.delete(f"/api/sessions/{sid}", headers=hdrs).status_code == 404
    assert api.post(
        "/api/chat/stream", headers=hdrs,
        json={"message": "hola", "session_id": sid},
    ).status_code == 404


def test_session_delete(api, user_a):
    sid = S["session_off_topic"]
    assert api.delete(f"/api/sessions/{sid}", headers=bearer(user_a["token"])).status_code == 204
    ids = [s["id"] for s in api.get("/api/sessions", headers=bearer(user_a["token"])).json()]
    assert sid not in ids
    assert api.get(f"/api/sessions/{sid}/messages", headers=bearer(user_a["token"])).json() == []


# ── 6. Feedback ───────────────────────────────────────────────────────────────

def test_feedback_submit_and_update(api, user_a):
    mid = S["message1"]
    assert api.post(
        f"/api/messages/{mid}/feedback", headers=bearer(user_a["token"]), json={"rating": "up"}
    ).status_code == 201
    # Same user re-rates → update, not duplicate.
    assert api.post(
        f"/api/messages/{mid}/feedback", headers=bearer(user_a["token"]), json={"rating": "down"}
    ).status_code == 201


def test_feedback_validation_and_ownership(api, user_a, user_b):
    mid = S["message1"]
    assert api.post(
        f"/api/messages/{mid}/feedback", headers=bearer(user_a["token"]), json={"rating": "meh"}
    ).status_code == 422
    assert api.post(
        f"/api/messages/{mid}/feedback", headers=bearer(user_b["token"]), json={"rating": "up"}
    ).status_code == 404
    assert api.post(f"/api/messages/{mid}/feedback", json={"rating": "up"}).status_code in (401, 403)


def test_feedback_admin_list(api, admin_token, user_a):
    resp = api.get("/api/admin/feedback", headers=bearer(admin_token))
    assert resp.status_code == 200
    entries = [f for f in resp.json() if f["message_id"] == S["message1"]]
    assert entries and entries[0]["rating"] == "down"  # the updated value, once
    assert api.get("/api/admin/feedback", headers=bearer(user_a["token"])).status_code == 403


# ── 6b. Support requests (human escalation) ───────────────────────────────────
# Keep POSTs to /api/escalations ≤5 per 60s — the endpoint is rate-limited.

def test_escalation_requires_an_account(api):
    body = {"name": "Invitado", "phone": "5512345678", "reason": "no puedo facturar un pedido"}
    assert api.post("/api/escalations", json=body).status_code in (401, 403)
    # Guests are barred from the whole feature — request and uploads alike.
    assert api.post(
        "/api/escalations", headers=bearer(S["guest_token"]), json=body
    ).status_code == 403
    assert api.post(
        "/api/escalations/attachments", headers=bearer(S["guest_token"]),
        files={"file": ("captura.png", PNG_BYTES, "image/png")},
    ).status_code == 403


def test_escalation_attachment_upload(api, user_a):
    ok = api.post(
        "/api/escalations/attachments", headers=bearer(user_a["token"]),
        files={"file": ("captura.png", PNG_BYTES, "image/png")},
    )
    assert ok.status_code == 201, ok.text
    meta = ok.json()
    assert meta["url"].startswith("/data/escalations/") and meta["content_type"] == "image/png"
    S["attachment"] = meta

    bad = api.post(
        "/api/escalations/attachments", headers=bearer(user_a["token"]),
        files={"file": ("malware.exe", b"MZ....", "application/octet-stream")},
    )
    assert bad.status_code == 400


def test_escalation_create_and_admin_flow(api, user_a, admin_token):
    created = api.post(
        "/api/escalations", headers=bearer(user_a["token"]),
        json={
            "email": "ana@example.com", "phone": "(55) 1234-5678", "name": "Ana",
            "reason": "Necesito ayuda con facturación", "session_id": S["session1"],
            "attachments": [S["attachment"]],
        },
    )
    assert created.status_code == 201
    eid = created.json()["id"]
    S["escalation_id"] = eid

    # A create referencing a URL outside /data/escalations/ is rejected.
    assert api.post(
        "/api/escalations", headers=bearer(user_a["token"]),
        json={"name": "Ana", "email": "x@x.com", "reason": "adjunto que no subí yo",
              "attachments": [{"file_name": "kb.pdf", "url": "/data/pdfs/kb.pdf"}]},
    ).status_code == 422

    # Admin sees it with the attachment; non-admin is forbidden.
    listing = api.get("/api/admin/escalations", headers=bearer(admin_token))
    assert listing.status_code == 200
    body = listing.json()
    assert body["new_count"] >= 1
    row = next(r for r in body["items"] if r["id"] == eid)
    # Both ways back are stored, phone normalised to its 10 digits.
    assert row["contact"] == "ana@example.com · 5512345678" and row["status"] == "new"
    assert row["session_id"] == S["session1"]
    # The conversation is snapshotted as a PDF and filed first, ahead of the
    # user's own upload, so support sees what was tried before the screenshots.
    assert len(row["attachments"]) == 2
    transcript, uploaded = row["attachments"]
    assert transcript["file_name"] == "conversacion.pdf"
    assert transcript["url"].startswith("/data/escalations/") and transcript["size"] > 0
    assert uploaded["url"] == S["attachment"]["url"]
    assert api.get("/api/admin/escalations", headers=bearer(user_a["token"])).status_code == 403

    # Both attachments are viewable via a signed stream URL.
    for att, head in ((S["attachment"], b"\x89PNG"), (transcript, b"%PDF")):
        signed = api.post("/api/media/sign", headers=bearer(admin_token), json={"gcs_url": att["url"]})
        assert signed.status_code == 200
        streamed = api.get(signed.json()["url"])
        assert streamed.status_code == 200 and streamed.content.startswith(head)

    # Resolve it, then confirm it shows under the resolved filter.
    assert api.patch(f"/api/admin/escalations/{eid}", headers=bearer(admin_token), json={"status": "resolved"}).status_code == 200
    resolved = api.get("/api/admin/escalations", params={"status": "resolved"}, headers=bearer(admin_token)).json()
    assert any(r["id"] == eid for r in resolved["items"])

    # Update validation + not-found + admin-only patch.
    assert api.patch(f"/api/admin/escalations/{eid}", headers=bearer(admin_token), json={"status": "banana"}).status_code == 422
    import uuid as _uuid
    assert api.patch(f"/api/admin/escalations/{_uuid.uuid4()}", headers=bearer(admin_token), json={"status": "resolved"}).status_code == 404
    assert api.patch(f"/api/admin/escalations/{eid}", headers=bearer(user_a["token"]), json={"status": "new"}).status_code == 403


# ── 7. Sharing ────────────────────────────────────────────────────────────────

def test_share_and_public_view(api, user_a):
    resp = api.post(f"/api/sessions/{S['session1']}/share", headers=bearer(user_a["token"]))
    assert resp.status_code == 200
    token = resp.json()["token"]
    S["share_token"] = token

    public = api.get(f"/api/shared/{token}")  # deliberately unauthenticated
    assert public.status_code == 200
    body = public.json()
    assert body["messages"] and body["title"]
    # No identity leaks in the public payload.
    assert "user_id" not in body and "user_label" not in body


def test_share_is_stable_and_owner_only(api, user_a, user_b):
    again = api.post(f"/api/sessions/{S['session1']}/share", headers=bearer(user_a["token"]))
    assert again.json()["token"] == S["share_token"]
    assert api.post(f"/api/sessions/{S['session1']}/share", headers=bearer(user_b["token"])).status_code == 404


def test_unshare_revokes_public_link(api, user_a):
    assert api.delete(f"/api/sessions/{S['session1']}/share", headers=bearer(user_a["token"])).status_code == 204
    assert api.get(f"/api/shared/{S['share_token']}").status_code == 404
    assert api.get("/api/shared/definitely-not-a-token").status_code == 404


def test_admin_can_share_any_conversation(api, admin_token):
    resp = api.post(f"/api/admin/conversations/{S['session1']}/share", headers=bearer(admin_token))
    assert resp.status_code == 200
    assert api.get(f"/api/shared/{resp.json()['token']}").status_code == 200


# ── 8. Media signing & streaming ──────────────────────────────────────────────

def test_media_sign_and_stream(api, user_a, e2e_doc):
    resp = api.post("/api/media/sign", headers=bearer(user_a["token"]), json={"gcs_url": e2e_doc["url"]})
    assert resp.status_code == 200
    url = resp.json()["url"]

    full = api.get(url)  # no auth header — the signature authorizes
    assert full.status_code == 200
    assert E2E_FACT_CODE in full.text

    partial = api.get(url, headers={"Range": "bytes=0-9"})
    assert partial.status_code == 206
    assert len(partial.content) == 10
    S["signed_url"] = url


def test_media_stream_rejects_tampering(api):
    base, _, _sig_val = S["signed_url"].rpartition("sig=")
    assert api.get(base + "sig=" + "0" * 64).status_code == 403


def test_media_stream_rejects_expired_link(api):
    from routers.media import _sig
    exp = int(time.time()) - 10
    path = S["signed_url"].split("/api/media/stream/", 1)[1].split("?")[0]
    from urllib.parse import unquote
    rel = unquote(path)
    assert api.get(f"/api/media/stream/{path}?exp={exp}&sig={_sig(rel, exp)}").status_code == 403


def test_media_sign_validation(api, user_a):
    assert api.post("/api/media/sign", json={"gcs_url": "/data/x.mp4"}).status_code in (401, 403)
    assert api.post(
        "/api/media/sign", headers=bearer(user_a["token"]),
        json={"gcs_url": "https://evil.example.com/x.mp4"},
    ).status_code == 400


# ── 9. Guest flow + admin conversation viewer ─────────────────────────────────

def test_guest_can_chat(api, e2e_doc):
    done = sse_ask(api, S["guest_token"], E2E_QUESTION)
    assert E2E_FACT_CODE in done["answer"]
    S["guest_session"] = done["session_id"]


def test_admin_conversations_list_and_filters(api, admin_token):
    hdrs = bearer(admin_token)
    all_convs = api.get("/api/admin/conversations", headers=hdrs).json()
    assert any(c["id"] == S["guest_session"] for c in all_convs)

    anon = api.get("/api/admin/conversations", params={"filter": "anonymous"}, headers=hdrs).json()
    guest_conv = next(c for c in anon if c["id"] == S["guest_session"])
    assert guest_conv["is_anonymous"] is True
    assert guest_conv["user_label"].startswith("Invitado #")

    searched = api.get("/api/admin/conversations", params={"q": "Renombrada por E2E"}, headers=hdrs).json()
    assert any(c["id"] == S["session1"] for c in searched)


def test_admin_conversation_detail_and_delete_cascade(api, admin_token, user_a):
    hdrs = bearer(admin_token)
    detail = api.get(f"/api/admin/conversations/{S['guest_session']}", headers=hdrs)
    assert detail.status_code == 200
    assert detail.json()["messages"]

    assert api.delete(f"/api/admin/conversations/{S['guest_session']}", headers=hdrs).status_code == 204
    assert api.get(f"/api/admin/conversations/{S['guest_session']}", headers=hdrs).status_code == 404

    assert api.get("/api/admin/conversations", headers=bearer(user_a["token"])).status_code == 403


def test_admin_stats(api, admin_token, user_a):
    resp = api.get("/api/admin/stats", headers=bearer(admin_token))
    assert resp.status_code == 200
    stats = resp.json()
    assert set(stats) == {"users", "sessions", "messages", "documents", "cache", "feedback"}
    assert stats["users"]["total"] >= 3
    assert stats["documents"]["total"] >= 1
    assert stats["messages"]["total"] >= 2
    assert api.get("/api/admin/stats", headers=bearer(user_a["token"])).status_code == 403


def test_suggestions_endpoint(api, user_a):
    resp = api.get("/api/suggestions", headers=bearer(user_a["token"]))
    assert resp.status_code == 200
    suggestions = resp.json()
    assert suggestions and all(s.get("label") and s.get("prompt") for s in suggestions)


# ── 10. Document delete CRUD (late: its cache flush would break cache tests) ──

def test_document_delete_flushes_cache(api, admin_token):
    name = "e2e_borrable.txt"
    resp = api.post(
        "/api/admin/upload", headers=bearer(admin_token),
        files={"file": (name, "Documento temporal E2E para probar el borrado.".encode(), "text/plain")},
    )
    assert resp.status_code == 200
    wait_for_document(api, admin_token, name)

    assert api.delete(f"/api/admin/documents/{name}", headers=bearer(admin_token)).status_code == 200
    docs = api.get("/api/admin/documents", headers=bearer(admin_token)).json()
    assert not any(d["file_name"] == name for d in docs)
    # KB changed → the whole semantic cache must be flushed.
    stats = api.get("/api/admin/cache/stats", headers=bearer(admin_token)).json()
    assert stats["total_entries"] == 0


def test_admin_cache_flush(api, admin_token, user_a):
    assert api.get("/api/admin/cache/stats", headers=bearer(user_a["token"])).status_code == 403
    assert api.delete("/api/admin/cache", headers=bearer(admin_token)).status_code == 204
    stats = api.get("/api/admin/cache/stats", headers=bearer(admin_token)).json()
    assert stats["total_entries"] == 0


# ── 11. Rate limiting (last — poisons the login window for ~60s) ──────────────

def test_login_rate_limit(api):
    saw_429 = None
    for _ in range(30):
        resp = api.post("/api/auth/login", json={"email": "flood@nexus.local", "password": "wrong"})
        if resp.status_code == 429:
            saw_429 = resp
            break
    assert saw_429 is not None, "no 429 after 30 rapid login attempts"
    assert "Retry-After" in saw_429.headers
