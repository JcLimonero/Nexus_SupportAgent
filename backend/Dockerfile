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

# tesseract-ocr + the Spanish pack back PyMuPDF's get_textpage_ocr(), used to
# read the image-only TotalDealer manuals (see config.ocr_enabled).
# Deliberately AFTER the model downloads: those two layers are ~11 GB and take
# ~20 min to rebuild on the on-prem server. Putting apt packages in the first
# RUN would invalidate them on every system-dependency change.
RUN apt-get update && apt-get install -y \
    tesseract-ocr \
    tesseract-ocr-spa \
    && rm -rf /var/lib/apt/lists/*

# PyMuPDF shells out to Tesseract, which needs this to locate its language data.
ENV TESSDATA_PREFIX=/usr/share/tesseract-ocr/5/tessdata

COPY . .

# Give the non-root user ownership of the app, data, and model cache
RUN mkdir -p /data && chown -R nexus:nexus /app /data /opt/hf-cache

USER nexus

EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
