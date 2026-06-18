"use client";
import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/lib/AuthProvider";
import { ThemeToggle } from "@/components/ThemeToggle";
import { MarkdownContent } from "@/components/MessageBubble";
import { useToast } from "@/components/Toast";
import {
  getConversations,
  getConversation,
  deleteConversation,
  type ConversationSummary,
  type ConversationDetail,
} from "@/lib/api";

type Filter = "all" | "registered" | "anonymous";

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "Todos" },
  { key: "registered", label: "Registrados" },
  { key: "anonymous", label: "Invitados" },
];

function fmt(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("es-MX", {
    day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
  });
}

function ConversationsInner() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const { toast } = useToast();
  const userFilter = params.get("user");
  const sharedId = params.get("id");

  const [filter, setFilter]       = useState<Filter>("all");
  const [search, setSearch]       = useState("");
  const [list, setList]           = useState<ConversationSummary[]>([]);
  const [fetching, setFetching]   = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail]       = useState<ConversationDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [deleting, setDeleting]   = useState(false);

  useEffect(() => {
    if (!loading && (!user || !user.is_admin)) router.push("/chat");
  }, [user, loading, router]);

  const load = useCallback(async () => {
    setFetching(true);
    try {
      setList(await getConversations({
        filter,
        q: search.trim() || undefined,
        userId: userFilter || undefined,
      }));
    } catch {
      toast("Error al cargar las conversaciones.", "error");
    } finally {
      setFetching(false);
    }
  }, [filter, search, userFilter, toast]);

  useEffect(() => { if (user?.is_admin) load(); }, [user, load]);

  const openDetail = async (id: string) => {
    setSelectedId(id);
    setDetailLoading(true);
    setDetail(null);
    try {
      setDetail(await getConversation(id));
    } catch {
      toast("No se pudo abrir la conversación.", "error");
    } finally {
      setDetailLoading(false);
    }
  };

  // Deep link: open the conversation referenced by ?id= on load / when it changes.
  useEffect(() => {
    if (user?.is_admin && sharedId) openDetail(sharedId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, sharedId]);

  const handleShare = async (id: string) => {
    const url = `${window.location.origin}/admin/conversations?id=${id}`;
    try {
      await navigator.clipboard.writeText(url);
      toast("Enlace de la conversación copiado.", "success");
    } catch {
      toast("No se pudo copiar el enlace.", "error");
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("¿Eliminar esta conversación y todos sus mensajes? No se puede deshacer.")) return;
    setDeleting(true);
    try {
      await deleteConversation(id);
      toast("Conversación eliminada.", "success");
      setList((prev) => prev.filter((c) => c.id !== id));
      if (selectedId === id) { setSelectedId(null); setDetail(null); }
    } catch {
      toast("Error al eliminar la conversación.", "error");
    } finally {
      setDeleting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen" style={{ backgroundColor: "var(--bg-page)" }}>
        <span className="gv-label">Cargando...</span>
      </div>
    );
  }

  const badge = (anon: boolean) => (
    <span style={{
      fontFamily: '"Barlow Condensed", sans-serif', fontSize: 9, fontWeight: 600, letterSpacing: "1px",
      textTransform: "uppercase", padding: "1px 6px", borderRadius: "var(--radius-sm)",
      border: `1px solid ${anon ? "var(--nqt-blue, #0ea5e9)" : "var(--border-default)"}`,
      color: anon ? "var(--nqt-blue, #0ea5e9)" : "var(--text-muted)",
    }}>
      {anon ? "Invitado" : "Registrado"}
    </span>
  );

  return (
    <div className="min-h-screen" style={{ backgroundColor: "var(--bg-page)" }}>
      {/* Header */}
      <div className="px-8 py-5" style={{ background: "linear-gradient(135deg, #050f1a 0%, #0a2540 100%)", borderBottom: "1px solid #1e3a5f" }}>
        <div className="max-w-5xl mx-auto flex items-start justify-between">
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
              <div style={{ width: 3, height: 18, backgroundColor: "var(--nqt-blue, #0ea5e9)", borderRadius: 2 }} />
              <h1 style={{ fontFamily: '"Barlow Condensed", sans-serif', fontWeight: 700, fontSize: 22, color: "#ffffff", letterSpacing: "0.5px" }}>
                Conversaciones
              </h1>
            </div>
            <p style={{ fontSize: 12, color: "#64748b", marginTop: 2, fontWeight: 300, paddingLeft: 11 }}>
              {userFilter ? "Conversaciones de un usuario." : "Historial de chats de usuarios registrados e invitados."}
            </p>
            {userFilter && (
              <button onClick={() => router.push("/admin/conversations")}
                style={{ marginTop: 6, fontSize: 10, color: "var(--nqt-blue, #0ea5e9)", fontFamily: '"Barlow Condensed", sans-serif', fontWeight: 600, letterSpacing: "2px", textTransform: "uppercase", background: "none", border: "none", cursor: "pointer", textDecoration: "underline", paddingLeft: 11 }}>
                Ver todas →
              </button>
            )}
          </div>
          <div className="flex items-center gap-3 mt-1">
            <ThemeToggle className="p-1 transition-colors" style={{ color: "#64748b", background: "none", border: "none", cursor: "pointer" } as React.CSSProperties} />
            <button onClick={() => router.push("/admin")}
              style={{ fontSize: 10, color: "#64748b", fontFamily: '"Barlow Condensed", sans-serif', fontWeight: 600, letterSpacing: "2px", textTransform: "uppercase", background: "none", border: "none", cursor: "pointer" }}
              onMouseEnter={(e) => (e.currentTarget.style.color = "#e2e8f0")}
              onMouseLeave={(e) => (e.currentTarget.style.color = "#64748b")}>
              ← Admin
            </button>
          </div>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-4 md:px-8 py-6">
        {/* Filters + search */}
        {!userFilter && (
          <div className="flex flex-wrap items-center gap-3 mb-5">
            <div className="flex gap-1">
              {FILTERS.map((f) => (
                <button key={f.key} onClick={() => setFilter(f.key)}
                  style={{
                    fontFamily: '"Barlow Condensed", sans-serif', fontSize: 10, fontWeight: 700, letterSpacing: "1.5px",
                    textTransform: "uppercase", padding: "6px 14px", cursor: "pointer", borderRadius: "var(--radius-sm)",
                    border: "1px solid var(--border-default)",
                    backgroundColor: filter === f.key ? "var(--btn-primary-bg)" : "transparent",
                    color: filter === f.key ? "var(--btn-primary-text)" : "var(--text-muted)",
                  }}>
                  {f.label}
                </button>
              ))}
            </div>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") load(); }}
              placeholder="Buscar por nombre o título..."
              style={{ flex: 1, minWidth: 200, backgroundColor: "var(--input-bg)", border: "1px solid var(--input-border)", borderRadius: "var(--radius)", color: "var(--text-primary)", padding: "8px 12px", fontSize: 13, fontWeight: 300, outline: "none" }}
              onFocus={(e) => (e.target.style.borderColor = "var(--input-focus)")}
              onBlur={(e) => (e.target.style.borderColor = "var(--input-border)")}
            />
          </div>
        )}

        <div className="grid gap-5" style={{ gridTemplateColumns: "minmax(280px, 360px) 1fr" }}>
          {/* List */}
          <div style={{ backgroundColor: "var(--bg-surface)", border: "1px solid var(--border-default)", borderRadius: "var(--radius)", overflow: "hidden", alignSelf: "start" }}>
            <div className="px-4 py-3" style={{ borderBottom: "1px solid var(--border-default)" }}>
              <span className="gv-label">Conversaciones</span>
              <span style={{ marginLeft: 8, fontSize: 10, color: "var(--text-faint)", fontFamily: '"Barlow Condensed", sans-serif' }}>({list.length})</span>
            </div>
            <div style={{ maxHeight: "65vh", overflowY: "auto" }}>
              {fetching && <p style={{ padding: "16px", fontSize: 12, color: "var(--text-muted)", fontWeight: 300 }}>Cargando...</p>}
              {!fetching && list.length === 0 && (
                <p style={{ padding: "24px 16px", fontSize: 12, color: "var(--text-muted)", fontWeight: 300, textAlign: "center" }}>No hay conversaciones.</p>
              )}
              {list.map((c) => (
                <button key={c.id} onClick={() => openDetail(c.id)}
                  className="w-full text-left px-4 py-3 transition-colors"
                  style={{
                    background: selectedId === c.id ? "var(--bg-muted)" : "none",
                    borderLeft: selectedId === c.id ? "3px solid var(--nqt-blue, #0ea5e9)" : "3px solid transparent",
                    borderBottom: "1px solid var(--border-default)", cursor: "pointer", display: "block",
                  }}>
                  <div className="flex items-center gap-2" style={{ marginBottom: 3 }}>
                    {badge(c.is_anonymous)}
                    <span style={{ fontSize: 12, color: "var(--text-primary)", fontWeight: 400, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {c.user_label ?? c.user_id}
                    </span>
                  </div>
                  <div style={{ fontSize: 12, color: "var(--text-secondary)", fontWeight: 300, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {c.title ?? "(sin título)"}
                  </div>
                  <div style={{ fontSize: 10, color: "var(--text-faint)", fontFamily: '"Barlow Condensed", sans-serif', letterSpacing: "0.5px", marginTop: 2 }}>
                    {c.message_count} mensajes · {fmt(c.last_message_at)}
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Detail */}
          <div style={{ backgroundColor: "var(--bg-surface)", border: "1px solid var(--border-default)", borderRadius: "var(--radius)", overflow: "hidden", alignSelf: "start", minHeight: 200 }}>
            {!selectedId && (
              <p style={{ padding: "40px 24px", fontSize: 13, color: "var(--text-muted)", fontWeight: 300, textAlign: "center" }}>
                Selecciona una conversación para ver el detalle.
              </p>
            )}
            {selectedId && detailLoading && (
              <p style={{ padding: "24px", fontSize: 12, color: "var(--text-muted)", fontWeight: 300 }}>Cargando conversación...</p>
            )}
            {detail && !detailLoading && (
              <>
                <div className="px-5 py-4 flex items-start justify-between gap-3" style={{ borderBottom: "1px solid var(--border-default)" }}>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2" style={{ marginBottom: 4 }}>
                      {badge(detail.is_anonymous)}
                      <span style={{ fontSize: 13, color: "var(--text-primary)", fontWeight: 500 }}>{detail.user_label ?? detail.user_id}</span>
                    </div>
                    <p style={{ fontSize: 13, color: "var(--text-secondary)", fontWeight: 300 }}>{detail.title ?? "(sin título)"}</p>
                    <p style={{ fontSize: 10, color: "var(--text-faint)", fontFamily: '"Barlow Condensed", sans-serif', letterSpacing: "0.5px", marginTop: 2 }}>
                      Iniciada {fmt(detail.created_at)}
                    </p>
                  </div>
                  <div className="flex items-center gap-2" style={{ flexShrink: 0 }}>
                    <button onClick={() => handleShare(detail.id)} title="Copiar enlace a esta conversación"
                      style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: '"Barlow Condensed", sans-serif', fontWeight: 600, letterSpacing: "1px", textTransform: "uppercase", background: "none", border: "1px solid var(--border-default)", borderRadius: "var(--radius-sm)", padding: "5px 10px", cursor: "pointer", display: "flex", alignItems: "center", gap: 5 }}
                      onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--nqt-blue, #0ea5e9)"; e.currentTarget.style.color = "var(--nqt-blue, #0ea5e9)"; }}
                      onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--border-default)"; e.currentTarget.style.color = "var(--text-muted)"; }}>
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
                        <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
                      </svg>
                      Compartir
                    </button>
                    <button onClick={() => handleDelete(detail.id)} disabled={deleting}
                      style={{ fontSize: 10, color: "#c0392b", fontFamily: '"Barlow Condensed", sans-serif', fontWeight: 600, letterSpacing: "1px", textTransform: "uppercase", background: "none", border: "1px solid #c0392b", borderRadius: "var(--radius-sm)", padding: "5px 10px", cursor: deleting ? "not-allowed" : "pointer", opacity: deleting ? 0.5 : 1 }}>
                      Eliminar
                    </button>
                  </div>
                </div>
                <div className="px-5 py-5 space-y-3" style={{ maxHeight: "60vh", overflowY: "auto" }}>
                  {detail.messages.map((m) => {
                    const isUser = m.role === "user";
                    const srcs = [
                      ...((m.sources?.pdfs as { file_name?: string }[] | undefined) ?? []),
                      ...((m.sources?.videos as { file_name?: string }[] | undefined) ?? []),
                    ].map((s) => s.file_name).filter(Boolean) as string[];
                    return (
                      <div key={m.id} className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
                        <div style={{
                          maxWidth: "82%", padding: "10px 14px",
                          backgroundColor: isUser ? "var(--bubble-user-bg, var(--bg-muted))" : "var(--bubble-ai-bg)",
                          border: `1px solid ${isUser ? "var(--border-default)" : "var(--bubble-ai-border)"}`,
                          borderLeft: isUser ? undefined : "3px solid var(--nqt-blue, #0ea5e9)",
                          borderRadius: "var(--radius)",
                        }}>
                          <p style={{ fontSize: 9, fontFamily: '"Barlow Condensed", sans-serif', fontWeight: 700, letterSpacing: "1.5px", textTransform: "uppercase", color: "var(--text-faint)", marginBottom: 4 }}>
                            {isUser ? "Usuario" : "Asistente"} · {fmt(m.created_at)}
                          </p>
                          {isUser ? (
                            <p style={{ fontSize: 13, color: "var(--text-secondary)", fontWeight: 300, lineHeight: 1.65, whiteSpace: "pre-wrap" }}>
                              {m.content}
                            </p>
                          ) : (
                            <div style={{ fontSize: 13, color: "var(--text-secondary)", fontWeight: 300, lineHeight: 1.65 }}>
                              <MarkdownContent>{m.content}</MarkdownContent>
                            </div>
                          )}
                          {srcs.length > 0 && (
                            <div className="flex flex-wrap gap-1.5" style={{ marginTop: 8 }}>
                              {srcs.map((f, i) => (
                                <span key={i} title={f} style={{ fontSize: 9, fontFamily: '"Barlow Condensed", sans-serif', fontWeight: 600, letterSpacing: "0.5px", color: "var(--text-muted)", border: "1px solid var(--border-default)", borderRadius: "var(--radius-sm)", padding: "1px 6px", maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                  {f}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                  {detail.messages.length === 0 && (
                    <p style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 300, textAlign: "center", padding: "20px 0" }}>Sin mensajes.</p>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function ConversationsPage() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center min-h-screen" style={{ backgroundColor: "var(--bg-page)" }}>
        <span className="gv-label">Cargando...</span>
      </div>
    }>
      <ConversationsInner />
    </Suspense>
  );
}
