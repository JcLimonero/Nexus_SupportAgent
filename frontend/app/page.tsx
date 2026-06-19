"use client";
import { useEffect, useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/AuthProvider";
import { localLogin, guestLogin } from "@/lib/auth";
import { ThemeToggle } from "@/components/ThemeToggle";

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
      <div className="flex items-center justify-center min-h-screen" style={{ background: "linear-gradient(135deg, #071929 0%, #0a2540 100%)" }}>
        <span style={{ color: "#94a3b8", fontSize: 12, letterSpacing: 2, fontFamily: "var(--font-condensed)", fontWeight: 600 }}>
          CARGANDO...
        </span>
      </div>
    );
  }

  return (
    <div
      className="flex items-center justify-center min-h-screen relative"
      style={{ background: "linear-gradient(135deg, #071929 0%, #0a2540 60%, #0d2137 100%)" }}
    >
      {/* subtle grid pattern */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          backgroundImage: "radial-gradient(circle at 1px 1px, rgba(14,165,233,0.08) 1px, transparent 0)",
          backgroundSize: "32px 32px",
        }}
      />

      {/* Theme toggle */}
      <div className="absolute top-4 right-4 z-10">
        <ThemeToggle
          className="p-2 transition-colors"
          style={{ color: "#64748b" } as React.CSSProperties}
        />
      </div>

      <div
        className="w-full max-w-sm relative z-10"
        style={{
          backgroundColor: "var(--bg-surface)",
          border: "1px solid var(--border-default)",
          borderRadius: "var(--radius-lg)",
          boxShadow: "0 25px 50px rgba(0,0,0,0.4)",
          overflow: "hidden",
          animation: "nqt-slideUp 0.5s cubic-bezier(0.16, 1, 0.3, 1) both",
        }}
      >
        {/* Card header — navy gradient */}
        <div
          className="px-8 pt-8 pb-7"
          style={{ background: "linear-gradient(135deg, #0a2540 0%, #0d2f54 100%)", borderBottom: "1px solid #1e3a5f" }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
            {/* NQT brandmark — white rounded tile keeps the navy mark crisp on the dark header */}
            <div style={{ width: 38, height: 38, borderRadius: 8, background: "#ffffff", display: "flex", alignItems: "center", justifyContent: "center", padding: 4, flexShrink: 0 }}>
              <Image src="/brand/nqt-mark-sm.png" alt="Nexus Q Tech" width={30} height={30} priority unoptimized style={{ display: "block", objectFit: "contain" }} />
            </div>
            <div>
              <div style={{ fontFamily: "var(--font-condensed)", fontWeight: 700, fontSize: 18, color: "#ffffff", textTransform: "uppercase", letterSpacing: 1, lineHeight: 1 }}>
                Nexus Support
              </div>
              <div style={{ fontFamily: "var(--font-condensed)", fontWeight: 500, fontSize: 10, color: "#0ea5e9", textTransform: "uppercase", letterSpacing: "2px", marginTop: 2 }}>
                TotalDealer · AI Agent
              </div>
            </div>
          </div>
          <p style={{ fontSize: 12, color: "#64748b", marginTop: 12, fontWeight: 300 }}>
            Inicia sesión para acceder al asistente.
          </p>
        </div>

        {/* Form */}
        <div className="px-8 py-7">
          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label className="gv-label block mb-1.5">Correo electrónico</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="w-full px-3 py-2.5 text-sm font-light focus:outline-none transition-colors"
                style={{
                  backgroundColor: "var(--input-bg)",
                  border: "1px solid var(--input-border)",
                  borderRadius: "var(--radius)",
                  color: "var(--text-primary)",
                }}
                onFocus={(e) => (e.target.style.borderColor = "var(--input-focus)")}
                onBlur={(e) => (e.target.style.borderColor = "var(--input-border)")}
              />
            </div>
            <div>
              <label className="gv-label block mb-1.5">Contraseña</label>
              <div style={{ position: "relative" }}>
                <input
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  className="w-full pl-3 pr-10 py-2.5 text-sm font-light focus:outline-none transition-colors"
                  style={{
                    backgroundColor: "var(--input-bg)",
                    border: "1px solid var(--input-border)",
                    borderRadius: "var(--radius)",
                    color: "var(--text-primary)",
                  }}
                  onFocus={(e) => (e.target.style.borderColor = "var(--input-focus)")}
                  onBlur={(e) => (e.target.style.borderColor = "var(--input-border)")}
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
                style={{ color: "#f87171", backgroundColor: "rgba(248,113,113,0.08)", padding: "8px 12px", borderRadius: "var(--radius-sm)", border: "1px solid rgba(248,113,113,0.2)", animation: "nqt-shake 0.45s ease" }}
              >
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="w-full py-2.5 transition-all disabled:opacity-50"
              style={{
                fontFamily: "var(--font-condensed)",
                fontWeight: 700,
                fontSize: 13,
                letterSpacing: "2px",
                textTransform: "uppercase",
                backgroundColor: "var(--btn-primary-bg)",
                color: "var(--btn-primary-text)",
                border: "none",
                borderRadius: "var(--radius)",
                cursor: submitting ? "not-allowed" : "pointer",
                marginTop: 8,
              }}
              onMouseEnter={(e) => { if (!submitting) e.currentTarget.style.backgroundColor = "var(--btn-primary-hover)"; }}
              onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "var(--btn-primary-bg)")}
            >
              {submitting ? "Iniciando sesión..." : "Iniciar sesión"}
            </button>
          </form>

          {/* Divider */}
          <div className="flex items-center gap-3" style={{ margin: "18px 0 14px" }}>
            <div style={{ flex: 1, height: 1, backgroundColor: "var(--border-default)" }} />
            <span style={{ fontFamily: "var(--font-condensed)", fontWeight: 600, fontSize: 9, letterSpacing: "2px", textTransform: "uppercase", color: "var(--text-faint)" }}>
              o
            </span>
            <div style={{ flex: 1, height: 1, backgroundColor: "var(--border-default)" }} />
          </div>

          {/* Guest access */}
          <button
            type="button"
            onClick={handleGuest}
            disabled={guestLoading}
            className="w-full py-2.5 transition-all disabled:opacity-50"
            style={{
              fontFamily: "var(--font-condensed)",
              fontWeight: 700,
              fontSize: 13,
              letterSpacing: "2px",
              textTransform: "uppercase",
              backgroundColor: "transparent",
              color: "var(--text-secondary)",
              border: "1px solid var(--input-border)",
              borderRadius: "var(--radius)",
              cursor: guestLoading ? "not-allowed" : "pointer",
            }}
            onMouseEnter={(e) => { if (!guestLoading) e.currentTarget.style.borderColor = "var(--input-focus)"; }}
            onMouseLeave={(e) => (e.currentTarget.style.borderColor = "var(--input-border)")}
          >
            {guestLoading ? "Entrando..." : "Continuar como invitado"}
          </button>
          <p style={{ fontSize: 11, color: "var(--text-faint)", marginTop: 8, textAlign: "center", fontWeight: 300 }}>
            Sin cuenta · tu conversación no se guardará en tu navegador.
          </p>
        </div>
      </div>
    </div>
  );
}
