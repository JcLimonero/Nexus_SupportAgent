# Nexus Support Agent

RAG-based support chatbot for TotalDealer ERP. Users ask questions in Spanish and get answers grounded in uploaded PDF manuals and training videos, with source citations and video playback.

## Features

- **SSE streaming** — AI answers stream token-by-token; stop generation mid-response with the Detener button
- **Session management** — conversations persist, can be renamed or deleted; sidebar lists all sessions with auto-generated titles
- **Semantic cache** — repeated or similar questions return cached answers instantly (pgvector cosine similarity)
- **Markdown rendering** — answers render headings, lists, code blocks, tables via react-markdown + rehype-sanitize
- **Follow-up suggestions** — each answer surfaces 3 related questions as one-click chips
- **Source document viewer** — PDF chips open an in-app panel showing the exact excerpt used; VID chips stream the video via short-lived signed URLs with native Range seeking (no full download)
- **Thumbs feedback** — users rate each answer up/down; admins view all feedback from the admin panel
- **Admin dashboard** — system stats (users, sessions, messages, documents, cache hits, feedback ratio), document upload/delete, and user management
- **User management** — create users, activate/deactivate, promote/demote admin role
- **Toast notifications** — success/error feedback on all admin and user actions
- **Theme toggle** — light / dark mode persisted via CSS variables
- **Grupo Vanguardia brand** — Barlow Condensed typeface, sharp corners, condensed uppercase labels
- **Security hardened** — OWASP Top 10 addressed: broken access control fixed, rate limiting, JWT TTL reduction, magic-bytes upload validation, CSP/HSTS headers, non-root Docker user, prompt injection markers

## Architecture

Production runs on-premises (Windows Server + IIS + Docker Compose). The only
cloud dependency is Vertex AI for the LLM:

```
                    ┌──────────────────────────────────────────────┐
  Browser ──HTTPS──▶│ IIS (ARR, TLS)  →  nginx on 127.0.0.1        │
                    │        ├──▶ frontend  Next.js 14 standalone  │
                    │        └──▶ backend   FastAPI + uvicorn      │
                    │                   │                          │
                    │                   ├──▶ PostgreSQL 16         │
                    │                   │    + pgvector 0.8.2      │
                    │                   ├──▶ /data volume (docs)   │
                    │                   └──▶ MiniLM embeddings     │
                    └───────────────────┼──────────────────────────┘
                                        ▼
                              ┌──────────────────────┐
                              │  Gemini 3.5 Flash    │
                              │  (Vertex AI, cloud)  │
                              └──────────────────────┘
```

Set `STORAGE_PROVIDER=gcs` / `EMBEDDING_PROVIDER=vertexai` to swap the storage
and embedding boxes for GCS and Vertex AI embeddings instead.

**Ingestion pipeline:** PDF/DOCX/PPTX/TXT/MD/CSV → text extraction → chunks → embeddings → pgvector  
**Media pipeline:** MP4/MP3/M4A/WAV/OGG → ffmpeg → faster-whisper (transcription) → timed chunks → embeddings  
**Query pipeline:** question → embed → semantic cache check → cosine search (HNSW) → Gemini 3.5 Flash → answer + sources

## Local development

### Prerequisites
- Docker Desktop
- `gcloud` CLI authenticated (`gcloud auth application-default login`)
- GCP project with Vertex AI enabled

### Start everything

```bash
docker compose up --build
```

| Service  | URL                        |
|----------|----------------------------|
| Frontend | http://localhost:3000      |
| Backend  | http://localhost:8000      |
| API docs | http://localhost:8000/docs |

Login with `admin@nexus.local` / `ChangeMe123!` in local mode.

> **Note:** API docs (`/docs`) are only available in local development. They are disabled in production.

### Provider switches (docker-compose.yml)

| Variable               | Local (default) | Prod (on-prem, live) | Prod (GCP, legacy) |
|------------------------|-----------------|----------------------|--------------------|
| `AUTH_PROVIDER`        | `local`         | `local`              | `local`            |
| `STORAGE_PROVIDER`     | `local`         | `local`              | `gcs`              |
| `EMBEDDING_PROVIDER`   | `local`         | `local`              | `vertexai`         |
| `EMBEDDING_DIMENSIONS` | `384`           | `384`                | `768`              |

`EMBEDDING_DIMENSIONS` is baked into the `document_chunks.embedding` column —
changing it requires re-indexing every document.

## Running tests

**Backend:**

```bash
docker compose run --rm backend python -m pytest tests/ -v
```

Or without Docker:

```bash
cd backend
pip install -r requirements.txt
AUTH_PROVIDER=local STORAGE_PROVIDER=local EMBEDDING_PROVIDER=local \
  DATABASE_URL=sqlite+aiosqlite:///./test.db RATE_LIMIT_ENABLED=false \
  pytest tests/ -v
```

**Frontend:**

```bash
cd frontend
npm install
npm test
```

## Running E2E tests

Both E2E tiers run against the **live local stack** — no mocks. They create their own users/documents/sessions and clean everything up afterwards. A full run costs ~5 real Gemini calls.

```bash
docker compose up -d          # stack must be running

# Tier 1 — API E2E: every CRUD surface + full RAG flow (52 tests, ~20s)
docker compose exec backend python -m pytest tests_e2e/ -v

# Tier 2 — browser E2E with Playwright (13 tests, ~30s)
cd frontend
npx playwright install chromium   # first time only
npm run e2e
```

Tier 1 covers auth, users/documents/sessions/feedback/sharing CRUD with ownership checks, semantic cache behavior, signed media streaming (Range/tampering/expiry), the admin panel APIs, and rate limiting. Tier 2 drives the real UI in Chromium: login/guest, streamed answers with citations, the source panel and signed document opening, sidebar rename/delete/search/collapse, public share links, admin upload/delete and user management, theme persistence, and the mobile overlay.

> Note: the API tier's rate-limit test intentionally exhausts the login limiter at the end of the run — wait ~60 s (or restart the backend) before logging in from the same machine.

## Project structure

```
backend/
  auth/           JWT auth — local username/password + HS256 tokens
  db/             SQLAlchemy models + async engine + init_db
  ingestion/      PDF (PyMuPDF) + docs (docx/pptx/txt/md/csv) + media (faster-whisper)
  llm/            Gemini 3.5 Flash client (Vertex AI)
  retrieval/      pgvector cosine search + context builder + semantic cache
  routers/        chat (SSE), admin (docs + stats + cache), users, media (signed streaming)
  tests/          117 pytest regression tests (auth, admin, chat, cache, feedback, media)
  tests_e2e/      52 API E2E tests against the live stack
frontend/
  app/            Next.js pages: login, chat, admin (dashboard + upload), admin/users
  components/     MessageBubble · SourcePanel · ThemeToggle · Toast
  lib/            auth (sessionStorage JWT) · api client (SSE)
  __mocks__/      Jest mocks for ESM packages (react-markdown, remark-gfm, rehype-sanitize)
.github/
  workflows/      CI/CD: backend tests → pip-audit → frontend tests → Docker build → deploy
```

## Production deployment (on-premises — Windows Server + IIS)

This is the live deployment. Full server-specific runbook: [`DEPLOY_CONTEXT.txt`](DEPLOY_CONTEXT.txt).

| Piece            | Value                                                        |
|------------------|--------------------------------------------------------------|
| Server           | `74.208.78.55` — **shared** with other projects (e.g. VGD)    |
| Public URL       | `https://app-nexusqtech.com`                                  |
| Stack            | `docker-compose.prod.yml` — db · backend · frontend · nginx   |
| Exposed port     | nginx on `127.0.0.1:${NGINX_HOST_PORT}` only — never public   |
| TLS / edge       | IIS + ARR proxies to that localhost port                      |
| Storage          | local `/data` volume (Docker named volume), not GCS           |
| Embeddings       | local MiniLM, 384 dims — no Vertex embedding cost             |
| LLM              | Gemini 3.5 Flash via Vertex AI (the only cloud dependency)     |

> **Isolation rule:** the server is shared. Do not touch ports 80/443/8080, other
> IIS sites or app pools, and never run `iisreset` — recycle only Nexus's own
> application pool. See `DEPLOY_CONTEXT.txt` before any server work.

```bash
# on the server, from the repo root
cp .env.prod.example .env    # fill in DB_PASSWORD, JWT_SECRET, ADMIN_*, NGINX_HOST_PORT
docker compose -f docker-compose.prod.yml up -d --build
```

`NEXT_PUBLIC_API_URL` is inlined into the browser bundle at **build time**, so
the public origin must be set before building the frontend image — a runtime env
var does *not* reach the client.

Cost model for this deployment: [`COSTOS.md`](COSTOS.md).

### CI/CD (GitHub Actions)

Every push/PR runs: backend tests → pip-audit → frontend tests → Docker build check.

The workflow also carries a **legacy Cloud Run deploy job** (`workflow_dispatch`
with `deploy=true`) from the original GCP deployment. It is not the production
path anymore and stays only as a fallback; it needs the `WIF_PROVIDER` and
`GCP_SERVICE_ACCOUNT` secrets. Production deploys are done on the server with
`docker compose -f docker-compose.prod.yml` as shown above.

## Adding documents

1. Open the app → **Admin** panel
2. Drag-and-drop a PDF, DOCX, PPTX, TXT, MD, CSV, MP4, MP3, M4A, WAV or OGG (max 100 MB)
3. Indexing runs in the background, one file at a time (PDFs: ~5 s/page, media: ~1 min per 10 min of audio)
4. Ask questions in the chat — answers cite the source pages/videos

Uploading or deleting a document flushes the semantic cache and the suggested
questions, since new content can change what the correct answer is.
