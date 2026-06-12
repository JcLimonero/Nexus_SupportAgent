FROM python:3.11-slim

RUN apt-get update && apt-get install -y \
    ffmpeg \
    gcc \
    libpq-dev \
    && rm -rf /var/lib/apt/lists/*

# Non-root user — reduces blast radius if a dependency vulnerability is exploited
# -m creates /home/nexus so HuggingFace/transformers cache writes succeed
RUN groupadd -r nexus && useradd -r -g nexus -m nexus

# Point HuggingFace cache to a fixed path that survives the root→nexus switch
ENV HF_HOME=/opt/hf-cache

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Pre-download models so first request is instant
RUN python -c "from faster_whisper import WhisperModel; WhisperModel('base', device='cpu', compute_type='int8')"
RUN python -c "from sentence_transformers import SentenceTransformer; SentenceTransformer('all-MiniLM-L6-v2')"

COPY . .

# Give the non-root user ownership of the app, data, and model cache
RUN mkdir -p /data && chown -R nexus:nexus /app /data /opt/hf-cache

USER nexus

EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
