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
  if (!resp.ok()) throw new Error(`chat/stream failed: ${resp.status()}${chatBlockedHint(resp.status())}`);
  await resp.text(); // drain the stream so the session is fully persisted
}

/** A 503 from a chat endpoint means exactly one thing here — a live
 * chat-blocking banner (service_status.is_chat_blocked) — so say so instead of
 * leaving a bare status code. */
export function chatBlockedHint(status: number): string {
  if (status !== 503) return "";
  return (
    " — a live status banner is blocking the chat. End it at /admin/avisos; on a stack whose" +
    " Gemini credentials are broken the self-monitor opens one by itself after ~3 failed checks."
  );
}

/** End every live chat-blocking status banner.
 *
 * Mirrors backend/tests_e2e/conftest.py::_clear_blocking_banners, down to the
 * scope: only `active` banners, and only the ones that block chat. Banners are
 * global state and the backend refuses every chat call while one is live, so
 * one left behind by someone testing /admin/avisos — or opened by the
 * self-monitor during a real outage — breaks specs that have nothing to do
 * with banners. Returns how many it ended.
 *
 * `manualOnly` skips the self-monitor's own incidents. Ending one only buys
 * quiet until the check fails `status_fail_threshold` more times (ending it
 * calls service_status.forget_incident, which resets that check's hysteresis
 * on purpose), so on a genuinely broken stack it comes back mid-run — worth it
 * before the run, since nothing can start otherwise, and pointless after it.
 * The teardown sweep therefore only clears what this suite could have left. */
export async function endBlockingBanners(
  request: APIRequestContext,
  adminToken: string,
  manualOnly = false,
): Promise<number> {
  const auth = { Authorization: `Bearer ${adminToken}` };
  const res = await request.get(`${API_URL}/api/admin/banners`, { headers: auth });
  if (!res.ok()) throw new Error(`banner list failed: ${res.status()} ${await res.text()}`);
  const { active } = (await res.json()) as { active: { id: string; blocks_chat: boolean; source: string }[] };

  const blocking = active.filter((b) => b.blocks_chat && !(manualOnly && b.source === "monitor"));
  for (const banner of blocking) {
    await request.patch(`${API_URL}/api/admin/banners/${banner.id}`, {
      headers: auth,
      data: { end_now: true },
    });
  }
  return blocking.length;
}
