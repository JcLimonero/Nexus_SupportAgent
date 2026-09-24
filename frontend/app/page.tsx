"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/AuthProvider";
import { localLogin, guestLogin } from "@/lib/auth";
import { ThemeToggle } from "@/components/ThemeToggle";
import { BrandLogo } from "@/components/BrandLogo";

export default function LoginPage() {
  const [email, setEmail]           = useState("");
  const [password, setPassword]     = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError]           = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [guestLoading, setGuestLoading] = useState(false);
  const router = useRouter();
  const { user, loading, refresh } = useAuth();

  useEffect(() => {
    if (!loading && user) router.push("/chat");
  }, [user, loading, router]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      await localLogin(email, password);
      refresh();
      router.push("/chat");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Credenciales incorrectas");
    } finally {
      setSubmitting(false);
    }
  };

  const handleGuest = async () => {
    setGuestLoading(true);
    setError("");
    try {
      await guestLogin();
      refresh();
      router.push("/chat");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "No se pudo iniciar como invitado");
    } finally {
      setGuestLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen" style={{ backgroundColor: "var(--bg-page)" }}>
        <span className="nqt-label">Cargando...</span>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center min-h-screen relative px-4 py-10" style={{ backgroundColor: "var(--bg-page)" }}>
      {/* Theme toggle */}
      <div className="absolute top-4 right-4 z-10">
        <ThemeToggle className="nqt-iconbtn" />
      </div>

      <div
        className="w-full max-w-sm relative z-10"
        style={{
          backgroundColor: "var(--bg-surface)",
          border: "1px solid var(--border-default)",
          borderRadius: "var(--radius-xl)",
          boxShadow: "var(--shadow)",
        }}
      >
        {/* Brand header */}
        <div className="px-8 pt-8 pb-2">
          <BrandLogo height={40} />
          <h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: "-0.02em", lineHeight: 1.2, color: "var(--text-primary)", marginTop: 28 }}>
            Iniciar sesión
          </h1>
          <p style={{ fontSize: 14, color: "var(--text-muted)", marginTop: 6, lineHeight: 1.55 }}>
            Asistente de soporte para usuarios de TotalDealer.
          </p>
        </div>

        {/* Form */}
        <div className="px-8 pt-5 pb-8">
          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label className="nqt-label block mb-1.5">Correo electrónico</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="nqt-input w-full px-3 py-2.5 text-sm"
              />
            </div>
            <div>
              <label className="nqt-label block mb-1.5">Contraseña</label>
              <div style={{ position: "relative" }}>
                <input
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  className="nqt-input w-full pl-3 pr-10 py-2.5 text-sm"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? "Ocultar contraseña" : "Mostrar contraseña"}
                  title={showPassword ? "Ocultar contraseña" : "Mostrar contraseña"}
                  style={{ position: "absolute", top: "50%", right: 8, transform: "translateY(-50%)", display: "flex", alignItems: "center", justifyContent: "center", background: "none", border: "none", cursor: "pointer", color: "var(--text-faint)", padding: 4, lineHeight: 1 }}
                  onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text-muted)")}
                  onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-faint)")}
                >
                  {showPassword ? (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" /><line x1="1" y1="1" x2="23" y2="23" /></svg>
                  ) : (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></svg>
                  )}
                </button>
              </div>
            </div>

            {error && (
              <p
                key={error}
                className="text-xs"
                style={{ color: "var(--danger-fg)", backgroundColor: "var(--danger-bg)", padding: "8px 12px", borderRadius: "var(--radius)", border: "1px solid var(--danger-border)", animation: "nqt-shake 0.45s ease" }}
              >
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="nqt-btn nqt-btn--md nqt-btn--primary w-full"
              style={{ marginTop: 8 }}
            >
              {submitting ? "Iniciando sesión..." : "Iniciar sesión"}
            </button>
          </form>

          {/* Divider */}
          <div className="flex items-center gap-3" style={{ margin: "18px 0 14px" }}>
            <div style={{ flex: 1, height: 1, backgroundColor: "var(--border-default)" }} />
            <span style={{ fontWeight: 600, fontSize: 10, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-faint)" }}>
              o
            </span>
            <div style={{ flex: 1, height: 1, backgroundColor: "var(--border-default)" }} />
          </div>

          {/* Guest access */}
          <button
            type="button"
            onClick={handleGuest}
            disabled={guestLoading}
            className="nqt-btn nqt-btn--md nqt-btn--ghost w-full"
          >
            {guestLoading ? "Entrando..." : "Continuar como invitado"}
          </button>
          <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 10, textAlign: "center" }}>
            Sin cuenta · tu conversación no se guardará en tu navegador.
          </p>
        </div>
      </div>
    </div>
  );
}
