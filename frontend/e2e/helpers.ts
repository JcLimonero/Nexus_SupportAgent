import { APIRequestContext, Page } from "@playwright/test";
import fs from "fs";
import path from "path";

export const API_URL = process.env.E2E_API_URL || "http://localhost:8000";
export const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL || "admin@nexus.local";
export const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD || "ChangeMe123!";

// Knowledge doc the browser suite uploads in global setup. Its activation code
// is a fact the assistant can only cite from this document.
export const UI_DOC_NAME = "e2e_ui_conocimiento.txt";
export const UI_FACT_CODE = "NEXUS-UI-7788";
export const UI_DOC_CONTENT =
  "El módulo Interfaz UI de TotalDealer se activa con el código " +
  `${UI_FACT_CODE}. Para activarlo, abra Configuración, seleccione Módulos y ` +
  `escriba el código ${UI_FACT_CODE} en el campo de licencia.`;
export const UI_QUESTION = "¿Cuál es el código de activación del módulo Interfaz UI?";

export const UI_USER_EMAIL = "e2e-ui@nexus.local";
export const UI_USER_PASSWORD = "UiPass123!";

const STATE_PATH = path.join(__dirname, ".state.json");

export interface E2EState {
  adminToken: string;
  uiToken: string;
  uiUserId: string;
}

export function writeState(state: E2EState) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state));
}

export function readState(): E2EState {
  return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
}

/** Put the JWT in localStorage before any page script runs — the app's
 * AuthProvider reads it from there on load. */
export async function injectToken(page: Page, token: string) {
  await page.addInitScript((t: string) => {
    window.localStorage.setItem("nexus_token", t);
  }, token);
}

/** Create a chat session via the API (SSE completes within the response body).
 * Repeating the same question is a semantic-cache hit — fast and free. */
export async function createSessionViaApi(
  request: APIRequestContext,
  token: string,
  message: string = UI_QUESTION,
): Promise<void> {
  const resp = await request.post(`${API_URL}/api/chat/stream`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { message },
    timeout: 120_000,
  });
  if (!resp.ok()) throw new Error(`chat/stream failed: ${resp.status()}`);
  await resp.text(); // drain the stream so the session is fully persisted
}
