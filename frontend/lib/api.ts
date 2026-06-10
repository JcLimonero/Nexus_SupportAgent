import { getBearerToken } from "./auth";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

async function headers(json = true): Promise<Record<string, string>> {
  const token = await getBearerToken();
  const h: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (json) h["Content-Type"] = "application/json";
  return h;
}

export type StreamEvent =
  | { token: string }
  | { done: true; session_id: string; answer: string; pdf_sources: unknown[]; video_sources: unknown[]; follow_ups: string[] }
  | { error: string };

export async function* sendMessageStream(
  message: string,
  sessionId: string | null,
): AsyncGenerator<StreamEvent> {
  const token = await getBearerToken();
  const res = await fetch(`${API_URL}/api/chat/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ message, session_id: sessionId }),
  });
  if (!res.ok || !res.body) throw new Error("Error al procesar la pregunta");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const chunk of parts) {
      if (chunk.startsWith("data: ")) {
        try { yield JSON.parse(chunk.slice(6)) as StreamEvent; } catch { /* skip malformed */ }
      }
    }
  }
}

export async function sendMessage(message: string, sessionId: string | null) {
  const res = await fetch(`${API_URL}/api/chat`, {
    method: "POST",
    headers: await headers(),
    body: JSON.stringify({ message, session_id: sessionId }),
  });
  if (!res.ok) throw new Error("Error al procesar la pregunta");
  return res.json();
}

export async function renameSession(sessionId: string, title: string) {
  const res = await fetch(`${API_URL}/api/sessions/${sessionId}`, {
    method: "PATCH",
    headers: await headers(),
    body: JSON.stringify({ title }),
  });
  if (!res.ok) throw new Error("Error al renombrar la sesión");
  return res.json();
}

export async function deleteSession(sessionId: string) {
  const res = await fetch(`${API_URL}/api/sessions/${sessionId}`, {
    method: "DELETE",
    headers: await headers(false),
  });
  if (!res.ok) throw new Error("Error al eliminar la sesión");
}

export async function getSuggestions(): Promise<{ label: string; prompt: string }[]> {
  try {
    const res = await fetch(`${API_URL}/api/suggestions`, { headers: await headers() });
    if (!res.ok) return [];
    return res.json();
  } catch {
    return [];
  }
}

export async function getSessions() {
  const res = await fetch(`${API_URL}/api/sessions`, { headers: await headers() });
  if (!res.ok) throw new Error("Error al obtener sesiones");
  return res.json();
}

export async function getSessionMessages(sessionId: string) {
  const res = await fetch(`${API_URL}/api/sessions/${sessionId}/messages`, {
    headers: await headers(),
  });
  if (!res.ok) throw new Error("Error al obtener mensajes");
  return res.json();
}

export async function uploadFile(file: File) {
  const h = await headers(false);
  const body = new FormData();
  body.append("file", file);
  const res = await fetch(`${API_URL}/api/admin/upload`, { method: "POST", headers: h, body });
  if (!res.ok) throw new Error("Error al subir el archivo");
  return res.json();
}

export async function getDocuments() {
  const res = await fetch(`${API_URL}/api/admin/documents`, { headers: await headers() });
  if (!res.ok) throw new Error("Error al obtener documentos");
  return res.json();
}

export async function deleteDocument(fileName: string) {
  const res = await fetch(`${API_URL}/api/admin/documents/${encodeURIComponent(fileName)}`, {
    method: "DELETE",
    headers: await headers(),
  });
  if (!res.ok) throw new Error("Error al eliminar el documento");
  return res.json();
}

export async function getExcerpt(chunkId: string) {
  const res = await fetch(`${API_URL}/api/admin/documents/excerpt/${chunkId}`, {
    headers: await headers(),
  });
  if (!res.ok) throw new Error("Error al obtener el fragmento");
  return res.json() as Promise<{
    chunk_id: string;
    file_name: string;
    source_type: string;
    page_number: number | null;
    content: string;
  }>;
}

export async function getDocumentBlobUrl(gcsUrl: string): Promise<string> {
  const path = gcsUrl.replace(/^\/data\//, "");
  const res = await fetch(`${API_URL}/api/admin/documents/serve/${path}`, {
    headers: await headers(false),
  });
  if (!res.ok) throw new Error("Error al obtener el documento");
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}
