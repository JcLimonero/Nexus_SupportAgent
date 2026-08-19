# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Spanish-language RAG support chatbot for the TotalDealer ERP. FastAPI backend + Next.js 14 frontend + PostgreSQL/pgvector, all in Docker Compose. Only cloud dependency is Gemini 3.5 Flash via Vertex AI. `README.md` covers features and deployment; this file covers what you can't see from one file.

## Commands

```bash
docker compose up --build          # whole stack: db:5432, backend:8000, frontend:3000

# Backend unit tests (mocked DB + mocked heavy deps, no stack needed)
docker compose run --rm backend python -m pytest tests/ -v
docker compose run --rm backend python -m pytest tests/test_chat.py::test_name -v

# Tier-1 E2E — real API against the live stack (~5 real Gemini calls)
docker compose exec backend python -m pytest tests_e2e/ -v

# Frontend
cd frontend && npm test                    # Jest
cd frontend && npm run e2e                 # Playwright (needs stack up; npx playwright install chromium first)
cd frontend && npm run build               # the only reliable type-check (see below)
```

Local admin login: `admin@nexus.local` / `ChangeMe123!`.

## Gotchas that cost time

- **Frontend hot-reload is broken on Windows bind-mounts.** `next dev` won't pick up changes. Clear the contents of `/app/.next` in the container and restart it. Always run `npm run build` to type-check — Jest won't catch type errors.
- **Back-to-back tier-1 E2E runs fail** with "admin login failed": the suite's last test intentionally exhausts the `/api/auth/login` rate limiter. Wait ~60 s or restart the backend between runs.
- **`EMBEDDING_DIMENSIONS` is baked into the `document_chunks.embedding` column type.** Changing provider (local MiniLM 384 ↔ Vertex 768) means re-indexing every document.
- **`NEXT_PUBLIC_API_URL` and `PUBLIC_ORIGIN` are build-time** for the frontend bundle. Changing them requires rebuilding the frontend image, not restarting it.
- **The TotalDealer PDFs are page screenshots** — ~100–150 chars of extractable text per page, 1700+ images. Their real content is never indexed; don't assume a PDF in `Recursos Capacitación TotalDealer/` is searchable.
- **`retrieval_max_distance = 0.8` is an untuned guess** (marked `ponytail:` in `config.py`), and the right value differs per embedding provider.
- **CI installs a hand-maintained pip list**, not `requirements.txt` (`.github/workflows/ci-cd.yml`). A new backend dependency that unit tests import must be added there too or CI fails while local Docker passes. The same job carries a list of `--ignore-vuln` pip-audit exceptions with reasons — read them before adding another.
- Use `gemini-3.7-flash` (GA 2026-08-13; ~half the token price of 3.5). `gemini_thinking_budget = 0` is deliberate and measured on 3.5 (~1.3 s TTFT vs 4–6 s with the default); don't "fix" it upward.

## Architecture

**Query pipeline** (`backend/routers/chat.py` → `retrieval/` → `llm/`): embed question once → semantic-cache lookup (`ResponseCache`, cosine distance ≤ 0.05) → on miss, pgvector cosine search over `DocumentChunk` (`retrieval_max_distance` filter, top `max_chunks_retrieved`) → `build_context` wraps each chunk in untrusted-data markers → Gemini SSE stream.

**The SSE contract** is the trickiest part of the codebase. `/api/chat/stream` yields `data: {...}` frames: `{token}` deltas, then one terminal `{done, session_id, message_id, answer, pdf_sources, video_sources, follow_ups}`. The model appends `NEXUS_FOLLOW_UPS: [...]` after the answer; `chat_stream` holds back the last `len(marker)-1` chars of every delta so a marker split across chunks is never leaked to the client, then splits answer/follow-ups at the marker. Cache hits emit the whole answer as a single token frame with `from_cache: true`, which tells the frontend to typewriter-reveal it. Consumer: `frontend/lib/api.ts` `sendMessageStream`.

**Two DB sessions per stream.** The request's `get_db` session is closed by the time generation finishes, so messages are persisted through a fresh `AsyncSessionLocal()` inside the generator, and `_touch_session` bumps `updated_at` manually (ORM `onupdate` never fires on that path).

**Sources are suppressed on "no info".** `_is_no_info()` matches the exact Spanish fallback prefix the system prompt mandates; when it fires, citations are dropped even though retrieval returned chunks.

**Auth** is JWT-only, HS256, no Firebase despite the filename — `auth/firebase_verify.get_current_user` just delegates to `verify_local_token`. Tokens carry `uid`, `email`, `is_admin`, and optionally `is_anon` for guests (`anon:<hex>` uid, label "Invitado #xxxx"). `user_id` on sessions is a plain string, so guest and registered sessions share one column. Frontend stores the token in **localStorage, not sessionStorage** — email deep links open new tabs and would otherwise bounce to login.

**Media/document serving** (`routers/media.py`): `/sign` (authenticated) mints an HMAC-signed, 1 h URL keyed on `local_jwt_secret`; `/stream/{path}` verifies the signature with no Authorization header, which is what lets `<video>` do native Range seeking. GCS mode issues V4 signed URLs instead.

**Ingestion** is a background task behind a `Semaphore(1)` (`routers/admin.py::_process_and_index`) — Whisper and ffmpeg would otherwise starve chat latency. PDFs → PyMuPDF, docs → `document_processor`, media → ffmpeg + faster-whisper with `media_chunk_size=150` words (~1 min of speech) so cited timestamps are useful. Upload/delete flushes the semantic cache and the suggestions cache.

**Human escalation** (`routers/escalations.py` + `transcript.py`): a user asks for a person → a ticket row admins triage at `/admin/escalations`, plus an optional email. Email goes through EmailJS's **server-side REST API** (no SMTP), needs "Allow EmailJS API for non-browser applications" enabled and the private key, and its credentials come from an untracked root `.env` — all-empty means email is silently disabled and the admin panel stays the source of truth. `transcript.py` renders the conversation twice from one message list (plain text for the email body, PDF for the attachment) and imports PyMuPDF as `pymupdf` on purpose: the unit-test conftest mocks `fitz`, and this module is tested for real. Attachments are capped against `emailjs_max_attach_kb` — over budget, the email sends without the PDF rather than being rejected whole.

**Rate limiting** is a pure-ASGI middleware in `main.py` (not `BaseHTTPMiddleware` — that would buffer SSE), per-process in-memory, keyed per IP+path prefix. Behind proxies it reads `trusted_proxy_hops` from the right of `X-Forwarded-For` (set 2 in prod: IIS/ARR → nginx → backend).

**Schema migrations** are hand-written `ALTER TABLE ... IF NOT EXISTS` statements in `main.py::_migrate()`. There is no Alembic — new columns go there.

**Provider switches** (`STORAGE_PROVIDER`, `EMBEDDING_PROVIDER`, `AUTH_PROVIDER`) are read in `config.py` and branched at each call site. Production is currently all-local except the LLM.

**One-off scripts** live at `backend/` root and are run with `docker compose run --rm backend python <script>.py`: `reindex_media.py` re-transcribes existing media so chunks gain `start_time` (idempotent, slow, flushes the cache).

## Testing layout

- `backend/tests/` — unit; `conftest.py` mocks `sentence_transformers`/`faster_whisper`/`fitz`/`google.auth` before app import and injects a `get_db` override returning a MagicMock session. Rate limiting is force-disabled there.
- `backend/tests_e2e/` — real HTTP against the running stack; creates and cleans up its own users/documents/sessions. Proves the full pipeline by uploading a doc containing a fact (`NEXUS-E2E-4321`) only that doc can supply.
- `frontend/e2e/` — Playwright, `workers: 1` because specs share real backend state.

## Conventions

- Branch per phase (`phase-N-name`), PR to `main`. Never commit directly to `main`.
- Every new endpoint gets auth / admin-role / validation / ownership pytest cases, and the E2E suites get extended alongside — not just unit tests.
- After a change: rebuild the containers and verify in the browser before calling it done.
- All user-facing strings are Spanish.
- `ponytail:` comments mark deliberate simplifications with their known ceiling and upgrade path; respect them rather than silently upgrading.
