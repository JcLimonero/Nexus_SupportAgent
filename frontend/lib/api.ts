import { getBearerToken } from "./auth";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

async function headers(json = true): Promise<Record<string, string>> {
  const token = await getBearerToken();
  const h: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (json) h["Content-Type"] = "application/json";
  return h;
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
