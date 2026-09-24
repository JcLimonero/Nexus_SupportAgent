"use client";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { getSharedConversation, type SharedConversation } from "@/lib/api";
import { BrandLogo } from "@/components/BrandLogo";
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
      <div className="px-6 md:px-8 py-4" style={{ backgroundColor: "var(--bg-header)", borderBottom: "1px solid var(--border-default)" }}>
        <div className="max-w-3xl mx-auto flex items-center gap-4">
          <BrandLogo height={32} />
          <div className="min-w-0 pl-4" style={{ borderLeft: "1px solid var(--border-default)" }}>
            <p className="td-eyebrow">Conversación compartida</p>
            {data?.title && (
              <p style={{ marginTop: 2, fontSize: 16, fontWeight: 700, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{data.title}</p>
            )}
            {data?.created_at && (
              <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 1 }}>
                {fmt(data.created_at)}
              </p>
            )}
          </div>
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-4 md:px-8 py-6">
        {loading && <p className="nqt-label">Cargando...</p>}
        {error && !loading && (
          <div style={{ backgroundColor: "var(--bg-surface)", border: "1px solid var(--border-default)", borderRadius: "var(--radius-lg)", boxShadow: "var(--shadow)", padding: "32px 24px", textAlign: "center" }}>
            <p style={{ fontSize: 14, color: "var(--text-primary)", fontWeight: 400, marginBottom: 6 }}>Conversación no disponible</p>
            <p style={{ fontSize: 13, color: "var(--text-muted)", fontWeight: 400 }}>
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
                    maxWidth: "85%", padding: "12px 16px",
                    backgroundColor: isUser ? "var(--bubble-user-bg)" : "var(--bubble-ai-bg)",
                    color: isUser ? "var(--bubble-user-text)" : "var(--bubble-ai-text)",
                    border: isUser ? "none" : "1px solid var(--bubble-ai-border)",
                    borderRadius: isUser ? "var(--radius-lg) var(--radius-lg) 6px var(--radius-lg)" : "6px var(--radius-lg) var(--radius-lg) var(--radius-lg)",
                    boxShadow: isUser ? undefined : "var(--shadow-sm)",
                  }}>
                    {isUser ? (
                      <p style={{ fontSize: 14.5, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{m.content}</p>
                    ) : (
                      <div style={{ fontSize: 14.5, lineHeight: 1.65 }}>
                        <MarkdownContent>{m.content}</MarkdownContent>
                      </div>
                    )}
                    {srcs.length > 0 && (
                      <div className="flex flex-wrap gap-1.5" style={{ marginTop: 8 }}>
                        {srcs.map((f, j) => (
                          <span key={j} title={f} style={{ fontSize: 11, fontWeight: 500, color: isUser ? "rgba(255,255,255,0.9)" : "var(--text-muted)", border: `1px solid ${isUser ? "rgba(255,255,255,0.45)" : "var(--border-default)"}`, borderRadius: "var(--radius-pill)", padding: "2px 9px", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
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
              <p style={{ fontSize: 13, color: "var(--text-muted)", fontWeight: 400, textAlign: "center", padding: "20px 0" }}>Esta conversación no tiene mensajes.</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
