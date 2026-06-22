# Nexus Support Agent

RAG-based support chatbot for TotalDealer ERP. Users ask questions in Spanish and get answers grounded in uploaded PDF manuals and training videos, with source citations and video playback.

## Features

- **SSE streaming** — AI answers stream token-by-token; stop generation mid-response with the Detener button
- **Session management** — conversations persist, can be renamed or deleted; sidebar lists all sessions with auto-generated titles
- **Semantic cache** — repeated or similar questions return cached answers instantly (pgvector cosine similarity)
- **Markdown rendering** — answers render headings, lists, code blocks, tables via react-markdown + rehype-sanitize
- **Follow-up suggestions** — each answer surfaces 3 related questions as one-click chips
- **Source document viewer** — PDF chips open an in-app panel showing the exact excerpt used; VID chips stream the video via signed blob URL
- **Thumbs feedback** — users rate each answer up/down; admins view all feedback from the admin panel
- **Admin dashboard** — system stats (users, sessions, messages, documents, cache hits, feedback ratio), document upload/delete, and user management
- **User management** — create users, activate/deactivate, promote/demote admin role
- **Toast notifications** — success/error feedback on all admin and user actions
- **Theme toggle** — light / dark mode persisted via CSS variables
- **Grupo Vanguardia brand** — Barlow Condensed typeface, sharp corners, condensed uppercase labels
- **Security hardened** — OWASP Top 10 addressed: broken access control fixed, rate limiting, JWT TTL reduction, magic-bytes upload validation, CSP/HSTS headers, non-root Docker user, prompt injection markers

## Architecture

```
┌─────────────────┐     ┌──────────────────────┐     ┌────────────────────┐
│  Next.js 14     │────▶│  FastAPI backend      │────▶│  Cloud SQL         │
│  (Cloud Run)    │     │  (Cloud Run)          │     │  PostgreSQL 16     │
└─────────────────┘     └──────────────────────┘     │  + pgvector 0.8.2  │
                                │                     └────────────────────┘
                    ┌───────────┼───────────┐
                    ▼           ▼           ▼
              ┌──────────┐ ┌────────┐ ┌──────────────┐
              │  Vertex  │ │  GCS   │ │  Gemini 3.5  │
              │  AI      │ │  Docs  │ │  Flash       │
              │  Embed.  │ │  Store │ │  (Vertex AI) │
              └──────────┘ └────────┘ └──────────────┘
```

**Ingestion pipeline:** PDFs → PyMuPDF → chunks → Vertex AI embeddings → pgvector  
**Video pipeline:** MP4 → ffmpeg → faster-whisper (transcription) → chunks → embeddings  
**Query pipeline:** question → semantic cache check → embed → cosine search → Gemini 3.5 Flash → answer + sources

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

| Variable               | Local (default) | Production  |
|------------------------|-----------------|-------------|
| `AUTH_PROVIDER`        | `local`         | `local`     |
| `STORAGE_PROVIDER`     | `local`         | `gcs`       |
| `EMBEDDING_PROVIDER`   | `local`         | `vertexai`  |
| `EMBEDDING_DIMENSIONS` | `384`           | `768`       |

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

## Project structure

```
backend/
  auth/           JWT auth — local username/password + HS256 tokens
  db/             SQLAlchemy models + async engine + init_db
  ingestion/      PDF (PyMuPDF) + video (faster-whisper) processors
  llm/            Gemini 3.5 Flash client (Vertex AI)
  retrieval/      pgvector cosine search + context builder + semantic cache
  routers/        chat (SSE), admin (docs + stats + cache), users, sessions, feedback
  tests/          63 pytest regression tests (auth, admin, chat, cache, feedback)
frontend/
  app/            Next.js pages: login, chat, admin (dashboard + upload), admin/users
  components/     MessageBubble · SourcePanel · ThemeToggle · Toast
  lib/            auth (sessionStorage JWT) · api client (SSE)
  __mocks__/      Jest mocks for ESM packages (react-markdown, remark-gfm, rehype-sanitize)
.github/
  workflows/      CI/CD: backend tests → pip-audit → frontend tests → Docker build → deploy
```

## Production deployment (Cloud Run)

Infrastructure is provisioned in GCP project `nexus-support-agent`:

| Resource              | Name / ID                                |
|-----------------------|------------------------------------------|
| Cloud Run (backend)   | `nexus-backend` — us-central1            |
| Cloud Run (frontend)  | `nexus-frontend` — us-central1           |
| Cloud SQL             | `nexus-db` — PostgreSQL 16 + pgvector    |
| GCS bucket            | `nexus-agent-docs-988042937611`          |
| Artifact Registry     | `nexus-repo` — us-central1               |
| Service account       | `nexus-cloudrun@...`                     |

### Manual deploy

```bash
docker build -t us-central1-docker.pkg.dev/nexus-support-agent/nexus-repo/backend:latest ./backend
docker push us-central1-docker.pkg.dev/nexus-support-agent/nexus-repo/backend:latest

gcloud run deploy nexus-backend \
  --image=us-central1-docker.pkg.dev/nexus-support-agent/nexus-repo/backend:latest \
  --region=us-central1 --project=nexus-support-agent \
  --service-account=nexus-cloudrun@nexus-support-agent.iam.gserviceaccount.com \
  --add-cloudsql-instances=nexus-support-agent:us-central1:nexus-db \
  --set-secrets="DATABASE_URL=nexus-database-url:latest,LOCAL_JWT_SECRET=nexus-jwt-secret:latest" \
  --set-env-vars="AUTH_PROVIDER=local,STORAGE_PROVIDER=gcs,EMBEDDING_PROVIDER=vertexai,EMBEDDING_DIMENSIONS=768,GCS_BUCKET_NAME=nexus-agent-docs-988042937611,VERTEX_AI_PROJECT=nexus-support-agent,VERTEX_AI_LOCATION=us-central1"
```

**Frontend** — `NEXT_PUBLIC_API_URL` is inlined into the browser bundle at **build time**, so it must be passed as a `--build-arg` (a Cloud Run runtime env var does *not* reach the client). First get the deployed backend URL, then build with it:

```bash
BACKEND_URL=$(gcloud run services describe nexus-backend \
  --region=us-central1 --project=nexus-support-agent --format='value(status.url)')

docker build --build-arg NEXT_PUBLIC_API_URL="$BACKEND_URL" \
  -t us-central1-docker.pkg.dev/nexus-support-agent/nexus-repo/frontend:latest ./frontend
docker push us-central1-docker.pkg.dev/nexus-support-agent/nexus-repo/frontend:latest

gcloud run deploy nexus-frontend \
  --image=us-central1-docker.pkg.dev/nexus-support-agent/nexus-repo/frontend:latest \
  --region=us-central1 --project=nexus-support-agent --allow-unauthenticated
```

### CI/CD (GitHub Actions)

Deploys are manual-trigger only (`workflow_dispatch`). Every push/PR runs: backend tests → pip-audit → frontend tests → Docker build check.

**Required GitHub secrets:**

| Secret                | Value                                                                                        |
|-----------------------|----------------------------------------------------------------------------------------------|
| `WIF_PROVIDER`        | `projects/988042937611/locations/global/workloadIdentityPools/github-pool/providers/github-provider` |
| `GCP_SERVICE_ACCOUNT` | `nexus-cloudrun@nexus-support-agent.iam.gserviceaccount.com`                                 |

## Adding documents

1. Open the app → **Admin** panel
2. Drag-and-drop a PDF or MP4 (max 100 MB)
3. Indexing runs in the background (PDFs: ~5s/page, videos: ~1 min/10 min of audio)
4. Ask questions in the chat — answers cite the source pages/videos
