const TOKEN_KEY = "nexus_token";
const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

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

export async function getBearerToken(): Promise<string> {
  const token = getLocalToken();
  if (!token) throw new Error("No autenticado");
  return token;
}
