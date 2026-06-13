"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/AuthProvider";
import { localLogin } from "@/lib/auth";
import { ThemeToggle } from "@/components/ThemeToggle";

export default function LoginPage() {
  const [email, setEmail]           = useState("");
  const [password, setPassword]     = useState("");
  const [error, setError]           = useState("");
  const [submitting, setSubmitting] = useState(false);
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

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen" style={{ background: "linear-gradient(135deg, #071929 0%, #0a2540 100%)" }}>
        <span style={{ color: "#94a3b8", fontSize: 12, letterSpacing: 2, fontFamily: '"Barlow Condensed", sans-serif', fontWeight: 600 }}>
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
        }}
      >
        {/* Card header — navy gradient */}
        <div
          className="px-8 pt-8 pb-7"
          style={{ background: "linear-gradient(135deg, #0a2540 0%, #0d2f54 100%)", borderBottom: "1px solid #1e3a5f" }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
            {/* NQT logo mark */}
            <div style={{ width: 32, height: 32, borderRadius: 6, background: "linear-gradient(135deg, #0ea5e9, #06b6d4)", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <span style={{ fontFamily: '"Barlow Condensed", sans-serif', fontWeight: 700, fontSize: 14, color: "#fff", letterSpacing: 0 }}>N</span>
            </div>
            <div>
              <div style={{ fontFamily: '"Barlow Condensed", sans-serif', fontWeight: 700, fontSize: 18, color: "#ffffff", textTransform: "uppercase", letterSpacing: 1, lineHeight: 1 }}>
                Nexus Support
              </div>
              <div style={{ fontFamily: '"Barlow Condensed", sans-serif', fontWeight: 500, fontSize: 10, color: "#0ea5e9", textTransform: "uppercase", letterSpacing: "2px", marginTop: 2 }}>
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
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
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

            {error && (
              <p className="text-xs" style={{ color: "#f87171", backgroundColor: "rgba(248,113,113,0.08)", padding: "8px 12px", borderRadius: "var(--radius-sm)", border: "1px solid rgba(248,113,113,0.2)" }}>
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="w-full py-2.5 transition-all disabled:opacity-50"
              style={{
                fontFamily: '"Barlow Condensed", sans-serif',
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
        </div>
      </div>
    </div>
  );
}
