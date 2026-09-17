# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Spanish-language RAG support chatbot for the TotalDealer ERP. FastAPI backend + Next.js 14 frontend + PostgreSQL/pgvector, all in Docker Compose. Only cloud dependency is Gemini 3.7 Flash via Vertex AI. `README.md` covers features and deployment; this file covers what you can't see from one file.

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
cd frontend && npm run lint

# Rebuild + re-index + measure retrieval, in one go (see scripts/)
.\scripts\rebuild-dev.ps1 -Reindex -Eval
.\scripts\rebuild-dev.ps1 -Eval            # measure only, change nothing
.\scripts\rebuild-dev.ps1 -Frontend        # backend-only by default; add this for frontend changes

# Production (run ON the server)
.\scripts\deploy-prod.ps1 -DryRun          # show incoming commits, touch nothing

# Retrieval quality (read-only; safe against prod)
docker compose exec backend python rag_eval.py --sweep
docker compose exec backend python rag_eval.py --verbose
```

Local admin login: `admin@nexus.local` / `ChangeMe123!`.

## Gotchas that cost time

- **Frontend hot-reload is broken on Windows bind-mounts.** `next dev` won't pick up changes. Clear the contents of `/app/.next` in the container and restart it. Always run `npm run build` to type-check — Jest won't catch type errors.
- **Back-to-back tier-1 E2E runs fail** with "admin login failed": the suite's last test intentionally exhausts the `/api/auth/login` rate limiter. Wait ~60 s or restart the backend between runs.
- **`EMBEDDING_DIMENSIONS` is baked into the `document_chunks.embedding` column type.** Changing provider (local MiniLM 384 ↔ Vertex 768) means re-indexing every document.
- **`NEXT_PUBLIC_API_URL` and `PUBLIC_ORIGIN` are build-time** for the frontend bundle. Changing them requires rebuilding the frontend image, not restarting it. Likewise the **prod backend has no code bind-mount** (`COPY . .` in the Dockerfile) — any code change in prod needs `build`, not a restart.
- **The TotalDealer PDFs are page screenshots** — ~100–150 chars of extractable text per page, 1700+ images. Phase 26 added an OCR fallback (`ocr_enabled`, `backend/ingestion/pdf_processor.py`): pages under `ocr_min_chars` are re-read through Tesseract at upload time. Anything indexed *before* that stays empty until `reindex_all.py --only pdf` runs, so a PDF being in the index doesn't mean its content is searchable — check the chunk length, not the chunk count. OCR of UI screenshots is noisy (garbled tokens between the real field names); it is a large gain over nothing, not clean prose.
- **OCR needs Tesseract in the image.** `backend/Dockerfile` installs `tesseract-ocr` + `tesseract-ocr-spa` and sets `TESSDATA_PREFIX`. If it's missing, `_ocr_page` logs one warning and silently degrades to the old behaviour — so a deploy that skipped the rebuild re-indexes scanned pages as empty with no error. `scripts/rebuild-dev.ps1` and `scripts/deploy-prod.ps1` both verify the binary and the `spa` language pack after starting.
- **`retrieval_max_distance = 0.8` never fires.** Measured 2026-09-11 with `rag_eval.py`: no chunk ever scores above ~0.61 with local MiniLM, so the cutoff drops nothing and every answer cites a full `max_chunks_retrieved` sources whether or not they're relevant. The value is per-provider and still untuned (`ponytail:` in `config.py`) — run `rag_eval.py --sweep` before changing it, and don't *loosen* it in response to "No tengo información" answers: the 2026-09 audit traced those to corpus gaps, not to the threshold.
- **`all-MiniLM-L6-v2` is an English-only model** serving a Spanish corpus. A 13-question probe put covered questions at mean distance 0.405 and uncovered ones at 0.472 — 0.067 of separation, which is why no absolute threshold can tell them apart. `paraphrase-multilingual-MiniLM-L12-v2` is the same 384 dims (no column-type change) and doubled that separation on the same probe, but scored slightly worse on top-1. Not enough evidence to swap; extend `backend/eval_set.json` and measure before touching it.
- **Status banners are global state.** One live `blocks_chat` banner disables the chat input in every browser, including every Playwright spec that follows. The backend also rejects chat calls while one is live (`is_chat_blocked`), so a banner left behind by hand fails ~20 tier-1 tests that have nothing to do with banners — `tests_e2e/conftest.py::_clear_blocking_banners` ends live blocking banners before the suite for exactly that reason. The E2E suites also delete what they create in `finally`/`afterEach` — keep both patterns. On a dev stack whose Gemini credentials are broken, the self-monitor opens such a banner by itself after 3 failed checks (~3 min), so chat specs failing with a disabled input means "look at `/admin/avisos`", not a UI bug.
- **CI installs a hand-maintained pip list**, not `requirements.txt` (`.github/workflows/ci-cd.yml`). A new backend dependency that unit tests import must be added there too or CI fails while local Docker passes. The same job carries a list of `--ignore-vuln` pip-audit exceptions with reasons — read them before adding another.
- Use `gemini-3.7-flash` (GA 2026-08-13; ~half the token price of 3.5). `gemini_thinking_budget = 0` is deliberate and measured on 3.5 (~1.3 s TTFT vs 4–6 s with the default); don't "fix" it upward. `README.md`, `COSTOS.md` and a few code comments still say "Gemini 3.5 Flash" and "IONOS VPS" — stale. The truth is `config.py` / `docker-compose.prod.yml`: 3.7, on-prem Windows Server + IIS.

## Architecture

**Query pipeline** (`backend/routers/chat.py` → `retrieval/` → `llm/`): embed question once → semantic-cache lookup (`ResponseCache`, cosine distance ≤ 0.05) → on miss, pgvector cosine search over `DocumentChunk` (`retrieval_max_distance` filter, top `max_chunks_retrieved`) → `build_context` wraps each chunk in untrusted-data markers → Gemini SSE stream.

**The SSE contract** is the trickiest part of the codebase. `/api/chat/stream` yields `data: {...}` frames: `{token}` deltas, then one terminal `{done, session_id, message_id, answer, pdf_sources, video_sources, follow_ups}`. The model appends a two-line trailer after the answer — `NEXUS_FUENTES: [1, 3]` then `NEXUS_FOLLOW_UPS: [...]`. `chat_stream` holds back the last `len(longest marker)-1` chars of every delta so a marker split across chunks is never leaked to the client, and the answer ends at whichever marker appears *first* (`_first_marker`), not at the follow-ups one. Each trailer line is parsed only to its own newline, so the two never swallow each other regardless of emission order. Cache hits emit the whole answer as a single token frame with `from_cache: true`, which tells the frontend to typewriter-reveal it. Consumer: `frontend/lib/api.ts` `sendMessageStream`.

**Two DB sessions per stream.** The request's `get_db` session is closed by the time generation finishes, so messages are persisted through a fresh `AsyncSessionLocal()` inside the generator, and `_touch_session` bumps `updated_at` manually (ORM `onupdate` never fires on that path).

**Sources are suppressed on "no info".** `_is_no_info()` matches the exact Spanish fallback prefix the system prompt mandates; when it fires, citations are dropped even though retrieval returned chunks. That rule outranks the model's own declaration.

**Citations are narrowed to what the model says it used.** Retrieval always hands over `max_chunks_retrieved` chunks whether or not they're relevant, and the 2026-09 audit found 28 of 28 production answers citing a full four. `_sources_for()` keeps only the `[Fragmento N]` numbers the model declares in `NEXUS_FUENTES`, then reuses `build_context` for the dedup. Measured against real Gemini on 17 questions: 3.75 → 1.00 sources per answer, with the correct document kept in 7/7 of the cases that already cited it. The three states are distinct and the distinction matters: `None` (no marker — cite everything, so an older model can't silently lose all citations), `[]` (the model read the fragments and none answered), and a populated list.

**Auth** is JWT-only, HS256, no Firebase despite the filename — `auth/firebase_verify.get_current_user` just delegates to `verify_local_token`. Tokens carry `uid`, `email`, `is_admin`, and optionally `is_anon` for guests (`anon:<hex>` uid, label "Invitado #xxxx"). `user_id` on sessions is a plain string, so guest and registered sessions share one column. Frontend stores the token in **localStorage, not sessionStorage** — email deep links open new tabs and would otherwise bounce to login.

**Media/document serving** (`routers/media.py`): `/sign` (authenticated) mints an HMAC-signed, 1 h URL keyed on `local_jwt_secret`; `/stream/{path}` verifies the signature with no Authorization header, which is what lets `<video>` do native Range seeking. GCS mode issues V4 signed URLs instead.

**Ingestion** is a background task behind a `Semaphore(1)` (`routers/admin.py::_process_and_index`) — Whisper and ffmpeg would otherwise starve chat latency. PDFs → PyMuPDF, docs → `document_processor`, media → ffmpeg + faster-whisper with `media_chunk_size=150` words (~1 min of speech) so cited timestamps are useful. Upload/delete flushes the semantic cache and the suggestions cache.

**Human escalation** (`routers/escalations.py` + `transcript.py`): a user asks for a person → a ticket row admins triage at `/admin/escalations`, plus an optional email. Email goes through EmailJS's **server-side REST API** (no SMTP), needs "Allow EmailJS API for non-browser applications" enabled and the private key, and its credentials come from an untracked root `.env` — all-empty means email is silently disabled and the admin panel stays the source of truth. `transcript.py` renders the conversation twice from one message list (plain text for the email body, PDF for the attachment) and imports PyMuPDF as `pymupdf` on purpose: the unit-test conftest mocks `fitz`, and this module is tested for real. Attachments are capped against `emailjs_max_attach_kb` — over budget, the email sends without the PDF rather than being rejected whole.

**Service status** (`service_status.py` + `routers/status_banners.py`; UI `components/ServiceStatus.tsx` mounted in `app/layout.tsx`, admin at `/admin/avisos`). `StatusBanner` rows come from two sources, both internal: an admin writing one, and the self-monitor. There is deliberately no inbound channel — an external-monitor webhook (`POST /api/status/incidents`), an admin "simulate outage" endpoint and outage alert emails all existed on this branch and were removed on purpose, so don't reintroduce them without asking; `incident_key` and its partial unique index stay because the monitor dedupes its own incidents with them. The design is shaped by *what is down*: public `GET /api/status` never uses the request DB session and serves a 10 s in-memory cache that keeps the last good list when the DB fails; the monitor keeps its own incident in memory when it can't write it, and `public_status` only merges that copy in when the row isn't trustworthy (never persisted, or DB unreadable) — otherwise an admin who ended it early would see it reappear. When the backend is unreachable, the frontend provider counts two failed polls and shows a built-in fallback plus the last contact phone it saw (localStorage). The monitor opens/clears with hysteresis (`status_fail_threshold`/`status_ok_threshold`), and `restore_open_incidents` re-adopts open monitor rows at startup so a restart mid-outage can't orphan a banner. Its Gemini check combines a free `countTokens` probe with real stream failures that `chat.py` reports via `record_llm_result` — the probe can't see quota/overload. Chat blocking is UI-only (`chatBlocked` from `useServiceStatus`). Nothing about banners notifies anyone outside the app: the admin panel is the only place an outage shows up (EmailJS stays escalation-only). All of it is per-process (`ponytail:` in the module docstring). nginx exempts `/api/status` from `limit_req` because behind IIS every user shares one nginx client address.

**Rate limiting** is a pure-ASGI middleware in `main.py` (not `BaseHTTPMiddleware` — that would buffer SSE), per-process in-memory, keyed per IP+path prefix. Behind proxies it reads `trusted_proxy_hops` from the right of `X-Forwarded-For` (set 2 in prod: IIS/ARR → nginx → backend).

**Schema migrations** are hand-written `ALTER TABLE ... IF NOT EXISTS` statements in `main.py::_migrate()`. There is no Alembic — new columns go there.

**Provider switches** (`STORAGE_PROVIDER`, `EMBEDDING_PROVIDER`, `AUTH_PROVIDER`) are read in `config.py` and branched at each call site. Production is currently all-local except the LLM.

**One-off scripts** live at `backend/` root and are run with `docker compose run --rm backend python <script>.py` (or `exec` against a running stack):

- `reindex_media.py` — re-transcribes existing media so chunks gain `start_time` (idempotent, slow, flushes the cache).
- `reindex_all.py` — re-extracts and re-embeds documents already on disk, in place, one file at a time. For when the *indexing* changed rather than the files: OCR, embedding model, chunk sizes. Media is excluded unless `--include-media`. An interrupted run leaves each not-yet-reached file on its old chunks.
- `rag_eval.py` — read-only retrieval measurement against the live corpus, driven by `backend/eval_set.json` (real production questions plus the file that should answer each; `null` marks a topic the corpus doesn't cover, and those matter — a good cutoff returns nothing for them). `--sweep` compares thresholds. Run it before and after any retrieval change.
- `audit_report.py` — read-only export of conversations, escalations and document/disk cross-checks to CSV. Writes production PII, so its output is gitignored.

**Deployment scripts** live in `scripts/` and are PowerShell (the prod host is Windows Server). Both are UTF-8 **with BOM** — Windows PowerShell 5.1 reads a BOM-less `.ps1` as ANSI and the Spanish accents become parse errors. `rebuild-dev.ps1` wraps build → up → health → reindex → eval locally; `deploy-prod.ps1` runs *on the server* from the repo checkout (path resolved from `$PSScriptRoot`; runbook in `DEPLOY_CONTEXT.txt`), asks for confirmation before building (`-Force` skips it), stops on a failed health check, and deliberately never calls `docker compose down -v`, which would destroy `pgdata` and `nexus_data`.

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
