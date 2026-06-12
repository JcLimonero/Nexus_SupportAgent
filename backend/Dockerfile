FROM python:3.11-slim

RUN apt-get update && apt-get install -y \
    ffmpeg \
    gcc \
    libpq-dev \
    && rm -rf /var/lib/apt/lists/*

# Non-root user — reduces blast radius if a dependency vulnerability is exploited
RUN groupadd -r nexus && useradd -r -g nexus nexus

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Pre-download faster-whisper base model so first request is instant
RUN python -c "from faster_whisper import WhisperModel; WhisperModel('base', device='cpu', compute_type='int8')"

COPY . .

# Give the non-root user ownership of the app and data directories
RUN mkdir -p /data && chown -R nexus:nexus /app /data

USER nexus

EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
