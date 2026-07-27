const TOKEN_KEY = "nexus_token";
const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

// localStorage, not sessionStorage: sessionStorage is per-tab, so a deep link
// opened from an email (admin conversation, escalation) lands in a fresh tab
// with no token and bounces to login even while the user is signed in elsewhere.
// localStorage is shared across the origin's tabs; the JWT's own exp still ends it.
export function getLocalToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(TOKEN_KEY);
}

export function setLocalToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearLocalToken() {
  localStorage.removeItem(TOKEN_KEY);
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

export async function guestLogin(): Promise<void> {
  const res = await fetch(`${API_URL}/api/auth/guest`, { method: "POST" });
  if (res.status === 403) throw new Error("El acceso de invitados está deshabilitado");
  if (!res.ok) throw new Error("No se pudo iniciar la sesión de invitado");
  const data = await res.json();
  setLocalToken(data.access_token);
}

export async function localLogout() {
  clearLocalToken();
}

export async function getBearerToken(): Promise<string> {
  const token = getLocalToken();
  if (!token) throw new Error("No autenticado");
  return token;
}
