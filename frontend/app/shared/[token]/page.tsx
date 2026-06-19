"use client";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { getSharedConversation, type SharedConversation } from "@/lib/api";
import { MarkdownContent } from "@/components/MessageBubble";

function fmt(iso: string) {
  return new Date(iso).toLocaleDateString("es-MX", {
    day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

export default function SharedConversationPage() {
  const params = useParams();
  const token = Array.isArray(params.token) ? params.token[0] : params.token;
  const [data, setData] = useState<SharedConversation | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!token) return;
    getSharedConversation(token)
      .then(setData)
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, [token]);

  return (
    <div className="min-h-screen" style={{ backgroundColor: "var(--bg-page)" }}>
      {/* Header */}
      <div className="px-6 md:px-8 py-5" style={{ background: "linear-gradient(135deg, #050f1a 0%, #0a2540 100%)", borderBottom: "1px solid #1e3a5f" }}>
        <div className="max-w-3xl mx-auto">
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ width: 3, height: 18, backgroundColor: "var(--nqt-blue, #0ea5e9)", borderRadius: 2 }} />
            <span style={{ fontFamily: "var(--font-condensed)", fontWeight: 700, fontSize: 16, color: "#ffffff", textTransform: "uppercase", letterSpacing: 1 }}>
              Nexus Support
            </span>
            <span style={{ fontFamily: "var(--font-condensed)", fontWeight: 600, fontSize: 9, color: "#0ea5e9", textTransform: "uppercase", letterSpacing: "2px" }}>
              · Conversación compartida
            </span>
          </div>
          {data?.title && (
            <p style={{ marginTop: 8, fontSize: 14, color: "#cbd5e1", fontWeight: 300, paddingLeft: 11 }}>{data.title}</p>
          )}
          {data?.created_at && (
            <p style={{ fontSize: 10, color: "#475569", fontFamily: "var(--font-condensed)", letterSpacing: "0.5px", marginTop: 2, paddingLeft: 11 }}>
              {fmt(data.created_at)}
            </p>
          )}
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-4 md:px-8 py-6">
        {loading && <p className="gv-label">Cargando...</p>}
        {error && !loading && (
          <div style={{ backgroundColor: "var(--bg-surface)", border: "1px solid var(--border-default)", borderRadius: "var(--radius)", padding: "32px 24px", textAlign: "center" }}>
            <p style={{ fontSize: 14, color: "var(--text-primary)", fontWeight: 400, marginBottom: 6 }}>Conversación no disponible</p>
            <p style={{ fontSize: 13, color: "var(--text-muted)", fontWeight: 300 }}>
              El enlace no es válido o el propietario dejó de compartir esta conversación.
            </p>
          </div>
        )}
        {data && !loading && (
          <div className="space-y-3">
            {data.messages.map((m, i) => {
              const isUser = m.role === "user";
              const srcs = [
                ...((m.sources?.pdfs ?? [])),
                ...((m.sources?.videos ?? [])),
              ].map((s) => s.file_name).filter(Boolean) as string[];
              return (
                <div key={i} className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
                  <div style={{
                    maxWidth: "85%", padding: "10px 14px",
                    backgroundColor: isUser ? "var(--bubble-user-bg)" : "var(--bubble-ai-bg)",
                    color: isUser ? "var(--bubble-user-text)" : "var(--bubble-ai-text)",
                    border: isUser ? "none" : "1px solid var(--bubble-ai-border)",
                    borderLeft: isUser ? undefined : "3px solid var(--nqt-blue, #0ea5e9)",
                    borderRadius: isUser ? "var(--radius) var(--radius) 2px var(--radius)" : "2px var(--radius) var(--radius) var(--radius)",
                  }}>
                    {isUser ? (
                      <p style={{ fontSize: 13, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{m.content}</p>
                    ) : (
                      <div style={{ fontSize: 13, fontWeight: 300, lineHeight: 1.65 }}>
                        <MarkdownContent>{m.content}</MarkdownContent>
                      </div>
                    )}
                    {srcs.length > 0 && (
                      <div className="flex flex-wrap gap-1.5" style={{ marginTop: 8 }}>
                        {srcs.map((f, j) => (
                          <span key={j} title={f} style={{ fontSize: 9, fontFamily: "var(--font-condensed)", fontWeight: 600, letterSpacing: "0.5px", color: isUser ? "rgba(255,255,255,0.9)" : "var(--text-muted)", border: `1px solid ${isUser ? "rgba(255,255,255,0.45)" : "var(--border-default)"}`, borderRadius: "var(--radius-sm)", padding: "1px 6px", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {f}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
            {data.messages.length === 0 && (
              <p style={{ fontSize: 13, color: "var(--text-muted)", fontWeight: 300, textAlign: "center", padding: "20px 0" }}>Esta conversación no tiene mensajes.</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
