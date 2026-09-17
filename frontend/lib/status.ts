// Service-status banners: types, the public poll and the pure helpers the
// banner and the admin page share (kept here so Jest can test them directly).

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

export type Severity = "info" | "warning" | "critical";
export type BannerSource = "manual" | "monitor";

export interface BannerUpdate {
  at: string;
  text: string;
}

export interface StatusBanner {
  id: string;
  message: string;
  severity: Severity;
  blocks_chat: boolean;
  contact: string | null;
  starts_at: string;
  ends_at: string | null;
  eta_at: string | null;
  updates: BannerUpdate[];
  source: BannerSource;
}

/** The admin API adds bookkeeping the public endpoint hides. */
export interface AdminBanner extends StatusBanner {
  ended_at: string | null;
  incident_key: string | null;
  created_by: string | null;
  created_at: string | null;
}

export interface PublicStatus {
  state: "ok" | "degraded" | "down";
  chat_blocked: boolean;
  banners: StatusBanner[];
  generated_at: string;
}

export interface BannerInput {
  message?: string;
  severity?: Severity;
  blocks_chat?: boolean;
  contact?: string | null;
  starts_at?: string | null;
  ends_at?: string | null;
  eta_at?: string | null;
  end_now?: boolean;
}

export const SEVERITY_LABEL: Record<Severity, string> = {
  critical: "Servicio interrumpido",
  warning: "Aviso",
  info: "Información",
};

export const OFFLINE_MESSAGE =
  "No podemos conectar con el servicio en este momento. Estamos trabajando para restablecerlo.";

// ── Polling ──────────────────────────────────────────────────────────────────

export const POLL_MS = 60_000;
/** After a failed poll, check again sooner so an outage (or recovery) shows fast. */
export const RETRY_MS = 15_000;

/** ±10% so a whole office that opened the app at 9:00 doesn't poll in lockstep. */
export function jitter(ms: number): number {
  return Math.round(ms * (0.9 + Math.random() * 0.2));
}

/** The backend (or the proxy in front of it) can't be reached. */
export class StatusUnreachableError extends Error {}

/** Public — no Authorization header. Deliberately not apiFetch: its 401
 * handling would log a signed-in user out over a background poll. Network
 * errors and 5xx mean unreachable; other failures (e.g. 429) keep the last state. */
export async function fetchPublicStatus(signal?: AbortSignal): Promise<PublicStatus> {
  let res: Response;
  try {
    res = await globalThis.fetch(`${API_URL}/api/status`, { cache: "no-store", signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new StatusUnreachableError("network");
  }
  if (res.status >= 500) throw new StatusUnreachableError(`HTTP ${res.status}`);
  if (!res.ok) throw new Error(`status poll ignored: HTTP ${res.status}`);
  return res.json();
}

// ── Time labels ──────────────────────────────────────────────────────────────

const MINUTE = 60_000;

export function formatDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / MINUTE));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest ? `${hours} h ${rest} min` : `${hours} h`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours ? `${days} d ${restHours} h` : `${days} d`;
}

/** Clock time if it's today, otherwise day + month + time. */
export function formatWhen(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleString("es-MX", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function elapsedLabel(startsAt: string, now: Date = new Date()): string {
  const ms = now.getTime() - new Date(startsAt).getTime();
  return ms < MINUTE ? "Desde hace un momento" : `Desde hace ${formatDuration(ms)}`;
}

export function etaLabel(etaAt: string | null, now: Date = new Date()): string | null {
  if (!etaAt) return null;
  const ms = new Date(etaAt).getTime() - now.getTime();
  if (ms <= 0) return `Solución estimada para las ${formatWhen(etaAt, now)} · seguimos trabajando`;
  return `Tiempo estimado de solución: ~${formatDuration(ms)} (${formatWhen(etaAt, now)})`;
}

/** A phone-looking contact becomes a tap-to-call link; anything else stays text. */
export function telHref(contact: string): string | null {
  if (!/^[\d\s()+.-]+$/.test(contact)) return null;
  const dialable = contact.replace(/[^\d+]/g, "");
  return dialable.replace(/\D/g, "").length >= 7 ? `tel:${dialable}` : null;
}

// ── Per-browser memory ───────────────────────────────────────────────────────

const DISMISSED_KEY = "nexus_dismissed_banners";
const CONTACT_KEY = "nexus_status_contact";

/** Anything that blocks the chat or reports an outage can't be closed — the
 * user would be left with a disabled input and no explanation. */
export function canDismiss(b: StatusBanner): boolean {
  return b.severity !== "critical" && !b.blocks_chat;
}

/** Keyed on the update count, so a closed banner comes back when it gets news. */
export function dismissKey(b: StatusBanner): string {
  return `${b.id}:${b.updates.length}`;
}

export function readDismissed(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(DISMISSED_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === "string") : [];
  } catch {
    return [];
  }
}

export function saveDismissed(keys: string[]): void {
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify(keys.slice(-50)));
  } catch { /* storage unavailable — the banner just reappears on reload */ }
}

/** Kept so the offline fallback can still show a phone number when the
 * backend itself is the thing that's down. */
export function rememberContact(banners: StatusBanner[]): void {
  const contact = banners.find((b) => b.contact)?.contact;
  if (!contact) return;
  try { localStorage.setItem(CONTACT_KEY, contact); } catch { /* ignore */ }
}

export function lastKnownContact(): string | null {
  try { return localStorage.getItem(CONTACT_KEY); } catch { return null; }
}

// ── Admin form ───────────────────────────────────────────────────────────────

export const ETA_PRESETS = [30, 60, 120, 240];

export interface BannerFormState {
  message: string;
  severity: Severity;
  blocksChat: boolean;
  /** Once the admin touches the checkbox, picking a severity stops overriding it. */
  blocksTouched: boolean;
  contact: string;
  startMode: "now" | "scheduled";
  startsAt: string;   // datetime-local value (browser local time)
  endMode: "open" | "scheduled";
  endsAt: string;
  etaMode: "none" | "preset" | "custom";
  etaMinutes: number;
  etaAt: string;
}

export const EMPTY_BANNER_FORM: BannerFormState = {
  message: "",
  severity: "warning",
  blocksChat: false,
  blocksTouched: false,
  contact: "",
  startMode: "now",
  startsAt: "",
  endMode: "open",
  endsAt: "",
  etaMode: "none",
  etaMinutes: 60,
  etaAt: "",
};

/** ISO → `<input type="datetime-local">` value, in the browser's local time. */
export function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** datetime-local value (no zone → local time per the spec) → UTC ISO. */
export function fromLocalInput(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function bannerToForm(b: StatusBanner): BannerFormState {
  return {
    ...EMPTY_BANNER_FORM,
    message: b.message,
    severity: b.severity,
    blocksChat: b.blocks_chat,
    blocksTouched: true,
    contact: b.contact ?? "",
    startMode: "scheduled",
    startsAt: toLocalInput(b.starts_at),
    endMode: b.ends_at ? "scheduled" : "open",
    endsAt: toLocalInput(b.ends_at),
    etaMode: b.eta_at ? "custom" : "none",
    etaAt: toLocalInput(b.eta_at),
  };
}

/** Form → API body, or a Spanish error for the form. ETA presets count from
 * the start: "1 h" on a banner scheduled for 22:00 means 23:00, not an hour from now. */
export function bannerFormToInput(f: BannerFormState, now: Date): BannerInput | string {
  const message = f.message.trim();
  if (message.length < 5) return "El mensaje debe tener al menos 5 caracteres.";

  const startsAt = f.startMode === "scheduled" ? fromLocalInput(f.startsAt) : null;
  if (f.startMode === "scheduled" && !startsAt) return "Indica la fecha y hora de publicación.";
  const startMs = startsAt ? new Date(startsAt).getTime() : now.getTime();

  const endsAt = f.endMode === "scheduled" ? fromLocalInput(f.endsAt) : null;
  if (f.endMode === "scheduled" && !endsAt) return "Indica la fecha y hora de fin.";

  let etaAt: string | null = null;
  if (f.etaMode === "preset") etaAt = new Date(startMs + f.etaMinutes * MINUTE).toISOString();
  if (f.etaMode === "custom") {
    etaAt = fromLocalInput(f.etaAt);
    if (!etaAt) return "Indica la hora estimada de solución.";
  }

  return {
    message,
    severity: f.severity,
    blocks_chat: f.blocksChat,
    contact: f.contact.trim() || null,
    starts_at: startsAt,
    ends_at: endsAt,
    eta_at: etaAt,
  };
}
