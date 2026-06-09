import json

import google.auth
import google.auth.transport.requests
import httpx

from config import get_settings

settings = get_settings()

SYSTEM_PROMPT = """Eres Nexus, un asistente de soporte especializado en el sistema TotalDealer.

Reglas que debes seguir siempre:
1. Responde ÚNICAMENTE en español.
2. Basa tus respuestas EXCLUSIVAMENTE en el contexto proporcionado entre los fragmentos [Fragmento N].
3. Si la respuesta no está en el contexto, di exactamente: "No tengo información sobre ese tema en los documentos disponibles. Te recomiendo contactar al equipo de soporte."
4. Sé conciso y estructurado. Usa listas numeradas para pasos y viñetas para listas de opciones.
5. No inventes pasos, números de versión, rutas de menú ni configuraciones que no aparezcan en el contexto.
6. Cuando el contexto provenga de un video de capacitación, puedes mencionarlo al usuario."""

_ENDPOINT = (
    "https://{location}-aiplatform.googleapis.com/v1/projects/{project}"
    "/locations/{location}/publishers/google/models/{model}:generateContent"
)


def _get_token() -> str:
    credentials, _ = google.auth.default(
        scopes=["https://www.googleapis.com/auth/cloud-platform"]
    )
    credentials.refresh(google.auth.transport.requests.Request())
    return credentials.token


def ask_gemini(history: list[dict], question: str, context: str) -> str:
    """Synchronous — call via asyncio.to_thread from async context."""
    url = _ENDPOINT.format(
        location=settings.vertex_ai_location,
        project=settings.vertex_ai_project,
        model=settings.gemini_model,
    )

    contents = []
    for msg in history:
        contents.append({
            "role": "model" if msg["role"] == "assistant" else "user",
            "parts": [{"text": msg["content"]}],
        })
    contents.append({
        "role": "user",
        "parts": [{"text": f"Contexto de los documentos:\n{context}\n\n---\nPregunta: {question}"}],
    })

    payload = {
        "systemInstruction": {"parts": [{"text": SYSTEM_PROMPT}]},
        "contents": contents,
        "generationConfig": {"maxOutputTokens": 1024, "temperature": 0.1},
    }

    response = httpx.post(
        url,
        headers={"Authorization": f"Bearer {_get_token()}"},
        json=payload,
        timeout=60,
    )
    response.raise_for_status()
    return response.json()["candidates"][0]["content"]["parts"][0]["text"]
