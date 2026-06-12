"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/AuthProvider";
import { localLogin } from "@/lib/auth";
import { ThemeToggle } from "@/components/ThemeToggle";

export default function LoginPage() {
  const [email, setEmail]         = useState("");
  const [password, setPassword]   = useState("");
  const [error, setError]         = useState("");
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
      <div className="flex items-center justify-center min-h-screen" style={{ backgroundColor: "var(--bg-page)" }}>
        <span style={{ color: "var(--text-muted)", fontSize: 12, letterSpacing: 2, fontFamily: '"Barlow Condensed", sans-serif', fontWeight: 600 }}>
          CARGANDO...
        </span>
      </div>
    );
  }

  return (
    <div
      className="flex items-center justify-center min-h-screen relative"
      style={{ backgroundColor: "var(--bg-page)" }}
    >
      {/* Theme toggle — top right */}
      <div className="absolute top-4 right-4">
        <ThemeToggle className="p-2 transition-colors" style={{ color: "var(--text-muted)" } as React.CSSProperties} />
      </div>

      <div
        className="w-full max-w-sm"
        style={{ border: "1px solid var(--border-default)", backgroundColor: "var(--bg-surface)" }}
      >
        {/* Card header — always dark */}
        <div className="px-8 pt-8 pb-6" style={{ backgroundColor: "var(--gv-black, #222222)" }}>
          <div style={{ width: 36, height: 2, backgroundColor: "#98989A", marginBottom: 16 }} />
          <div style={{ fontFamily: '"Barlow Condensed", sans-serif', fontWeight: 700, fontSize: 44, color: "#ffffff", textTransform: "uppercase", letterSpacing: "-0.5px", lineHeight: 1 }}>
            NEXUS
          </div>
          <div style={{ fontFamily: '"Barlow Condensed", sans-serif', fontWeight: 600, fontSize: 12, color: "#98989A", textTransform: "uppercase", letterSpacing: 3, marginTop: 4 }}>
            SUPPORT AGENT
          </div>
        </div>

        {/* Form body */}
        <div className="px-8 py-8">
          <form onSubmit={handleLogin} className="space-y-5">
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
                  color: "var(--text-primary)",
                }}
                onFocus={(e) => (e.target.style.borderColor = "var(--input-focus)")}
                onBlur={(e) => (e.target.style.borderColor = "var(--input-border)")}
              />
            </div>

            {error && (
              <p className="text-xs" style={{ color: "#c0392b" }}>{error}</p>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="w-full py-3 transition-colors disabled:opacity-40"
              style={{
                fontFamily: '"Barlow Condensed", sans-serif',
                fontWeight: 700,
                fontSize: 12,
                letterSpacing: "2.5px",
                textTransform: "uppercase",
                backgroundColor: submitting ? "var(--btn-primary-bg)" : "var(--btn-primary-bg)",
                color: "var(--btn-primary-text)",
                border: "none",
                cursor: submitting ? "not-allowed" : "pointer",
              }}
              onMouseEnter={(e) => { if (!submitting) (e.currentTarget.style.backgroundColor = "var(--btn-primary-hover)"); }}
              onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "var(--btn-primary-bg)")}
            >
              {submitting ? "INICIANDO SESIÓN..." : "INICIAR SESIÓN"}
            </button>
          </form>

        </div>
      </div>
    </div>
  );
}
