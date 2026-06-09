# Nexus Support Agent

RAG-based support chatbot for TotalDealer ERP. Users ask questions in Spanish and get answers grounded in uploaded PDF manuals and training videos, with source citations and video links.

## Architecture

```
┌─────────────────┐     ┌──────────────────────┐     ┌────────────────────┐
│  Next.js 14     │────▶│  FastAPI backend      │────▶│  Cloud SQL         │
│  (Cloud Run)    │     │  (Cloud Run)          │     │  PostgreSQL 16     │
└─────────────────┘     └──────────────────────┘     │  + pgvector        │
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
**Query pipeline:** question → embed → cosine search → Gemini 3.5 Flash → answer + sources

## Local development

### Prerequisites
- Docker Desktop
- `gcloud` CLI authenticated (`gcloud auth application-default login`)
- GCP project with Vertex AI enabled

### Start everything

```bash
docker-compose up --build
```

| Service  | URL                   |
|----------|-----------------------|
| Frontend | http://localhost:3000 |
| Backend  | http://localhost:8000 |
| Docs API | http://localhost:8000/docs |

Login with any email / any password in local mode.

### Provider switches (docker-compose.yml)

| Variable             | Local (default) | Production      |
|----------------------|-----------------|-----------------|
| `AUTH_PROVIDER`      | `local`         | `local`         |
| `STORAGE_PROVIDER`   | `local`         | `gcs`           |
| `EMBEDDING_PROVIDER` | `local`         | `vertexai`      |
| `EMBEDDING_DIMENSIONS` | `384`         | `768`           |

## Running tests

```bash
cd backend
pip install pytest pytest-asyncio anyio httpx
pytest tests/ -v
```

Tests mock all external dependencies (GCP, embeddings, DB) and run fully offline.

## Project structure

```
backend/
  auth/           JWT auth (local) / Firebase verify stub
  db/             SQLAlchemy models + async engine + init_db
  ingestion/      PDF (PyMuPDF) + video (faster-whisper) processors
  llm/            Gemini 3.5 Flash client (Vertex AI global endpoint)
  retrieval/      pgvector cosine search + context builder
  routers/        chat, admin, health endpoints
  tests/          pytest regression tests
frontend/
  app/            Next.js pages (login, chat, admin)
  components/     MessageBubble with PDF/video source pills
  lib/            auth, api client, Firebase stub
.github/
  workflows/      CI/CD pipeline (test → build → deploy)
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
# Build and push
docker build -t us-central1-docker.pkg.dev/nexus-support-agent/nexus-repo/backend:latest ./backend
docker push us-central1-docker.pkg.dev/nexus-support-agent/nexus-repo/backend:latest

# Deploy backend
gcloud run deploy nexus-backend \
  --image=us-central1-docker.pkg.dev/nexus-support-agent/nexus-repo/backend:latest \
  --region=us-central1 --project=nexus-support-agent \
  --service-account=nexus-cloudrun@nexus-support-agent.iam.gserviceaccount.com \
  --add-cloudsql-instances=nexus-support-agent:us-central1:nexus-db \
  --set-secrets="DATABASE_URL=nexus-database-url:latest,LOCAL_JWT_SECRET=nexus-jwt-secret:latest" \
  --set-env-vars="AUTH_PROVIDER=local,STORAGE_PROVIDER=gcs,EMBEDDING_PROVIDER=vertexai,EMBEDDING_DIMENSIONS=768,GCS_BUCKET_NAME=nexus-agent-docs-988042937611,VERTEX_AI_PROJECT=nexus-support-agent,VERTEX_AI_LOCATION=us-central1"
```

### CI/CD (GitHub Actions)

Every push to `main` runs tests then deploys automatically via Workload Identity Federation (no keys stored in GitHub).

**Required GitHub secrets:**

| Secret               | Value                                                                                      |
|----------------------|-------------------------------------------------------------------------------------------|
| `WIF_PROVIDER`       | `projects/988042937611/locations/global/workloadIdentityPools/github-pool/providers/github-provider` |
| `GCP_SERVICE_ACCOUNT`| `nexus-cloudrun@nexus-support-agent.iam.gserviceaccount.com`                              |

Add these at: `github.com/JcLimonero/Nexus_SupportAgent` → Settings → Secrets → Actions.

## Adding documents

1. Open the app → **Admin** tab
2. Drag-and-drop a PDF or MP4
3. Indexing runs in the background (PDFs: ~5s/page, videos: ~1min/10min of audio)
4. Ask questions in the chat — answers cite the source pages/videos
