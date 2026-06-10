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
3. Si la respuesta no está en el contexto, usa en el campo "answer": "No tengo información sobre ese tema en los documentos disponibles. Te recomiendo contactar al equipo de soporte."
4. Sé conciso y estructurado. Usa listas numeradas para pasos y viñetas para listas de opciones.
5. No inventes pasos, números de versión, rutas de menú ni configuraciones que no aparezcan en el contexto.
6. Cuando el contexto provenga de un video de capacitación, puedes mencionarlo al usuario."""

_RESPONSE_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "answer": {"type": "STRING"},
        "follow_ups": {
            "type": "ARRAY",
            "items": {"type": "STRING"},
        },
    },
    "required": ["answer", "follow_ups"],
}

_ENDPOINT = (
    "https://aiplatform.googleapis.com/v1/projects/{project}"
    "/locations/global/publishers/google/models/{model}:generateContent"
)


def _get_token() -> str:
    credentials, _ = google.auth.default(
        scopes=["https://www.googleapis.com/auth/cloud-platform"]
    )
    credentials.refresh(google.auth.transport.requests.Request())
    return credentials.token


def ask_gemini(history: list[dict], question: str, context: str) -> dict:
    """Synchronous — call via asyncio.to_thread from async context.
    Returns {"answer": str, "follow_ups": list[str]}.
    """
    url = _ENDPOINT.format(
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
        "parts": [{"text": (
            f"Contexto de los documentos:\n{context}\n\n---\n"
            f"Pregunta: {question}\n\n"
            "Responde con JSON: campo 'answer' con tu respuesta en Markdown, y "
            "'follow_ups' con 2-3 preguntas de seguimiento relevantes (lista vacía si no aplica)."
        )}],
    })

    payload = {
        "systemInstruction": {"parts": [{"text": SYSTEM_PROMPT}]},
        "contents": contents,
        "generationConfig": {
            "maxOutputTokens": 1024,
            "temperature": 0.1,
            "responseMimeType": "application/json",
            "responseSchema": _RESPONSE_SCHEMA,
        },
    }

    response = httpx.post(
        url,
        headers={"Authorization": f"Bearer {_get_token()}"},
        json=payload,
        timeout=60,
    )
    response.raise_for_status()
    # Gemini 3.5 Flash may return a "thought" part before the actual response.
    # Only read parts where thought != True.
    parts = response.json()["candidates"][0]["content"]["parts"]
    text_parts = [p["text"] for p in parts if "text" in p and not p.get("thought", False)]
    raw = text_parts[-1] if text_parts else parts[0]["text"]
    try:
        result = json.loads(raw)
        return {
            "answer": str(result.get("answer", raw)),
            "follow_ups": [str(f) for f in result.get("follow_ups", []) if f],
        }
    except (json.JSONDecodeError, KeyError):
        return {"answer": raw, "follow_ups": []}
