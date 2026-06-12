/**
 * Unified auth helpers.
 * LOCAL_DEV=true  → JWT stored in sessionStorage, issued by our own backend.
 * LOCAL_DEV=false → Firebase ID token.
 */
const IS_LOCAL = process.env.NEXT_PUBLIC_LOCAL_DEV === "true";
const TOKEN_KEY = "nexus_token";
const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

// ── Local JWT helpers ────────────────────────────────────────────────────────

export function getLocalToken(): string | null {
  if (typeof window === "undefined") return null;
  return sessionStorage.getItem(TOKEN_KEY);
}

export function setLocalToken(token: string) {
  sessionStorage.setItem(TOKEN_KEY, token);
}

export function clearLocalToken() {
  sessionStorage.removeItem(TOKEN_KEY);
}

export async function localLogin(email: string, password: string): Promise<void> {
  const res = await fetch(`${API_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error("Correo electrónico o contraseña incorrectos");
  const data = await res.json();
  setLocalToken(data.access_token);
}

export async function localLogout() {
  clearLocalToken();
}

// ── Unified: get the current bearer token ────────────────────────────────────

export async function getBearerToken(): Promise<string> {
  if (IS_LOCAL) {
    const token = getLocalToken();
    if (!token) throw new Error("No autenticado");
    return token;
  }
  // Firebase path
  const { auth } = await import("./firebase");
  const user = auth.currentUser;
  if (!user) throw new Error("No autenticado");
  return user.getIdToken();
}

export { IS_LOCAL };
