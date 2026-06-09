import anthropic

from config import get_settings

settings = get_settings()
_client: anthropic.Anthropic | None = None

SYSTEM_PROMPT = """Eres Nexus, el asistente de soporte especializado en el sistema TotalDealer.

Reglas que debes seguir siempre:
1. Responde ÚNICAMENTE en español.
2. Basa tus respuestas EXCLUSIVAMENTE en el contexto proporcionado entre los fragmentos [Fragmento N].
3. Si la respuesta no está en el contexto, di exactamente: "No tengo información sobre ese tema en los documentos disponibles. Te recomiendo contactar al equipo de soporte."
4. Sé conciso y estructurado. Usa listas numeradas para pasos y viñetas para listas de opciones.
5. No inventes pasos, números de versión, rutas de menú ni configuraciones que no aparezcan en el contexto.
6. Cuando el contexto provenga de un video de capacitación, puedes mencionarlo al usuario."""


def _get_client() -> anthropic.Anthropic:
    global _client
    if _client is None:
        _client = anthropic.Anthropic(api_key=settings.anthropic_api_key)
    return _client


def ask_claude(history: list[dict], question: str, context: str) -> str:
    """Synchronous — call via asyncio.to_thread from async context."""
    messages = list(history)
    messages.append({
        "role": "user",
        "content": f"Contexto de los documentos:\n{context}\n\n---\nPregunta: {question}",
    })

    response = _get_client().messages.create(
        model=settings.claude_model,
        max_tokens=1024,
        system=SYSTEM_PROMPT,
        messages=messages,
    )
    return response.content[0].text
