"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/AuthProvider";
import { IS_LOCAL, localLogout } from "@/lib/auth";
import { sendMessage, getSessions, getSessionMessages, getSuggestions, renameSession, deleteSession } from "@/lib/api";
import { MessageBubble, type Message, type PdfSource } from "@/components/MessageBubble";
import { SourcePanel } from "@/components/SourcePanel";
import { ThemeToggle } from "@/components/ThemeToggle";

interface Session {
  id: string;
  title: string | null;
  created_at: string;
}

export default function ChatPage() {
  const { user, loading, refresh } = useAuth();
  const router = useRouter();
  const [sessions, setSessions]               = useState<Session[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [messages, setMessages]               = useState<Message[]>([]);
  const [input, setInput]                     = useState("");
  const [sending, setSending]                 = useState(false);
  const [sidebarOpen, setSidebarOpen]         = useState(false);
  const [activeSource, setActiveSource]       = useState<PdfSource | null>(null);
  const [suggestions, setSuggestions]         = useState<{ label: string; prompt: string }[]>([]);
  const [editingId, setEditingId]             = useState<string | null>(null);
  const [editingTitle, setEditingTitle]       = useState("");
  const [deletingId, setDeletingId]           = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef  = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!loading && !user) router.push("/");
  }, [user, loading, router]);

  useEffect(() => {
    if (user) {
      loadSessions();
      getSuggestions().then(setSuggestions);
    }
  }, [user]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, sending]);

  const loadSessions = async () => {
    try { setSessions(await getSessions()); } catch {}
  };

  const openSession = async (id: string) => {
    setCurrentSessionId(id);
    setSidebarOpen(false);
    try { setMessages(await getSessionMessages(id)); } catch {}
  };

  const newChat = () => {
    setCurrentSessionId(null);
    setMessages([]);
    setSidebarOpen(false);
  };

  const handleLogout = async () => {
    if (IS_LOCAL) {
      localLogout();
      refresh();
    } else {
      const { signOut } = await import("firebase/auth");
      const { auth }    = await import("@/lib/firebase");
      await signOut(auth);
    }
    router.push("/");
  };

  const sendText = async (text: string) => {
    if (!text || sending) return;
    setSending(true);
    setMessages((p) => [...p, { role: "user", content: text }]);
    try {
      const res = await sendMessage(text, currentSessionId);
      setCurrentSessionId(res.session_id);
      setMessages((p) => [
        ...p,
        {
          role: "assistant",
          content: res.answer,
          sources: { pdfs: res.pdf_sources, videos: res.video_sources },
          follow_ups: res.follow_ups || [],
        },
      ]);
      loadSessions();
    } catch {
      setMessages((p) => [
        ...p,
        { role: "assistant", content: "Ocurrió un error. Por favor intenta de nuevo." },
      ]);
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  };

  const startEdit = (s: Session) => {
    setEditingId(s.id);
    setEditingTitle(s.title ?? fmt(s.created_at));
    setDeletingId(null);
  };

  const commitEdit = async (id: string) => {
    const title = editingTitle.trim();
    setEditingId(null);
    if (!title) return;
    try {
      await renameSession(id, title);
      setSessions((prev) => prev.map((s) => s.id === id ? { ...s, title } : s));
    } catch {}
  };

  const confirmDelete = async (id: string) => {
    setDeletingId(null);
    try {
      await deleteSession(id);
      setSessions((prev) => prev.filter((s) => s.id !== id));
      if (currentSessionId === id) {
        setCurrentSessionId(null);
        setMessages([]);
      }
    } catch {}
  };

  const handleSend = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const text = input.trim();
    if (!text || sending) return;
    setInput("");
    await sendText(text);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const fmt = (iso: string) =>
    new Date(iso).toLocaleDateString("es-MX", {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen" style={{ backgroundColor: "var(--bg-page)" }}>
        <span className="gv-label">Cargando...</span>
      </div>
    );
  }

  const sidebar = (
    <aside
      className="flex flex-col h-full"
      style={{ backgroundColor: "var(--bg-sidebar)", width: 256, flexShrink: 0 }}
    >
      {/* Brand header */}
      <div className="px-5 py-5" style={{ borderBottom: "1px solid #333" }}>
        <div style={{ fontFamily: '"Barlow Condensed", sans-serif', fontWeight: 700, fontSize: 18, color: "#ffffff", textTransform: "uppercase", letterSpacing: 1 }}>
          NEXUS SUPPORT
        </div>
        <div style={{ fontFamily: '"Barlow Condensed", sans-serif', fontWeight: 600, fontSize: 10, color: "#98989A", textTransform: "uppercase", letterSpacing: 3, marginTop: 2 }}>
          TOTALDEALDER
        </div>
      </div>

      {/* New chat */}
      <div className="px-4 py-3" style={{ borderBottom: "1px solid #333" }}>
        <button
          onClick={newChat}
          className="w-full py-2.5 px-3 text-center transition-colors"
          style={{
            fontFamily: '"Barlow Condensed", sans-serif',
            fontWeight: 700,
            fontSize: 11,
            letterSpacing: "2px",
            textTransform: "uppercase",
            backgroundColor: "#ffffff",
            color: "#222222",
            border: "none",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "#f0f0f0")}
          onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "#ffffff")}
        >
          + NUEVA CONVERSACIÓN
        </button>
      </div>

      {/* Session list */}
      <nav className="flex-1 overflow-y-auto py-2">
        {sessions.length === 0 && (
          <p style={{ padding: "12px 16px", fontSize: 10, color: "#555", fontFamily: '"Barlow Condensed", sans-serif', letterSpacing: 1, textTransform: "uppercase" }}>
            Sin conversaciones
          </p>
        )}
        {sessions.map((s) => (
          <div
            key={s.id}
            className="group relative"
            style={{
              backgroundColor: currentSessionId === s.id ? "#444444" : "transparent",
              borderLeft: currentSessionId === s.id ? "2px solid #888" : "2px solid transparent",
            }}
            onMouseEnter={(e) => {
              if (currentSessionId !== s.id) e.currentTarget.style.backgroundColor = "#2a2a2a";
            }}
            onMouseLeave={(e) => {
              if (currentSessionId !== s.id) e.currentTarget.style.backgroundColor = "transparent";
            }}
          >
            {/* Rename input */}
            {editingId === s.id ? (
              <input
                autoFocus
                value={editingTitle}
                onChange={(e) => setEditingTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitEdit(s.id);
                  if (e.key === "Escape") setEditingId(null);
                }}
                onBlur={() => commitEdit(s.id)}
                className="w-full px-4 py-2.5 focus:outline-none"
                style={{
                  fontFamily: '"Barlow Condensed", sans-serif',
                  fontSize: 12,
                  background: "#333",
                  color: "#fff",
                  border: "none",
                  borderBottom: "1px solid #666",
                }}
              />
            ) : deletingId === s.id ? (
              /* Delete confirmation */
              <div className="px-4 py-2.5">
                <p style={{ fontFamily: '"Barlow Condensed", sans-serif', fontSize: 10, letterSpacing: 1, textTransform: "uppercase", color: "#e88", marginBottom: 6 }}>
                  ¿Eliminar conversación?
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={() => confirmDelete(s.id)}
                    style={{ fontFamily: '"Barlow Condensed", sans-serif', fontSize: 10, letterSpacing: 1, textTransform: "uppercase", background: "#e44", color: "#fff", border: "none", cursor: "pointer", padding: "3px 8px" }}
                  >
                    Eliminar
                  </button>
                  <button
                    onClick={() => setDeletingId(null)}
                    style={{ fontFamily: '"Barlow Condensed", sans-serif', fontSize: 10, letterSpacing: 1, textTransform: "uppercase", background: "transparent", color: "#888", border: "1px solid #555", cursor: "pointer", padding: "3px 8px" }}
                  >
                    Cancelar
                  </button>
                </div>
              </div>
            ) : (
              /* Normal row */
              <button
                onClick={() => openSession(s.id)}
                className="w-full text-left px-4 py-2.5 pr-16"
                style={{ background: "none", border: "none", cursor: "pointer" }}
              >
                <span style={{ fontFamily: '"Barlow Condensed", sans-serif', fontSize: 12, color: currentSessionId === s.id ? "#fff" : "#bbb", display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {s.title ?? fmt(s.created_at)}
                </span>
                <span style={{ fontFamily: '"Barlow Condensed", sans-serif', fontSize: 10, letterSpacing: "0.5px", textTransform: "uppercase", color: "#555", display: "block" }}>
                  {fmt(s.created_at)}
                </span>
              </button>
            )}

            {/* Action icons — visible on hover when not editing/deleting */}
            {editingId !== s.id && deletingId !== s.id && (
              <div
                className="absolute right-2 top-1/2 -translate-y-1/2 hidden group-hover:flex gap-1"
              >
                {/* Rename */}
                <button
                  onClick={(e) => { e.stopPropagation(); startEdit(s); }}
                  title="Renombrar"
                  style={{ background: "none", border: "none", cursor: "pointer", color: "#666", padding: 4, lineHeight: 1 }}
                  onMouseEnter={(e) => (e.currentTarget.style.color = "#ccc")}
                  onMouseLeave={(e) => (e.currentTarget.style.color = "#666")}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                  </svg>
                </button>
                {/* Delete */}
                <button
                  onClick={(e) => { e.stopPropagation(); setDeletingId(s.id); setEditingId(null); }}
                  title="Eliminar"
                  style={{ background: "none", border: "none", cursor: "pointer", color: "#666", padding: 4, lineHeight: 1 }}
                  onMouseEnter={(e) => (e.currentTarget.style.color = "#e44")}
                  onMouseLeave={(e) => (e.currentTarget.style.color = "#666")}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
                    <path d="M10 11v6"/><path d="M14 11v6"/>
                    <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
                  </svg>
                </button>
              </div>
            )}
          </div>
        ))}
      </nav>

      {/* Footer */}
      <div className="px-4 py-4 space-y-2" style={{ borderTop: "1px solid #333" }}>
        {user && (
          <p style={{ fontSize: 10, color: "#555", fontFamily: '"Barlow Condensed", sans-serif', letterSpacing: 1, textTransform: "uppercase", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {user.email}
          </p>
        )}
        <button
          onClick={() => router.push("/admin")}
          className="w-full py-2 px-3 text-center transition-colors"
          style={{
            fontFamily: '"Barlow Condensed", sans-serif',
            fontWeight: 600,
            fontSize: 10,
            letterSpacing: "2px",
            textTransform: "uppercase",
            backgroundColor: "#333",
            color: "#999",
            border: "none",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = "#444"; e.currentTarget.style.color = "#ccc"; }}
          onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "#333"; e.currentTarget.style.color = "#999"; }}
        >
          Administrar documentos
        </button>
        <div className="flex items-center justify-between pt-1">
          <button
            onClick={handleLogout}
            style={{ fontSize: 10, color: "#555", fontFamily: '"Barlow Condensed", sans-serif', letterSpacing: 1, textTransform: "uppercase", background: "none", border: "none", cursor: "pointer" }}
            onMouseEnter={(e) => (e.currentTarget.style.color = "#888")}
            onMouseLeave={(e) => (e.currentTarget.style.color = "#555")}
          >
            Cerrar sesión
          </button>
          <ThemeToggle
            className="transition-colors p-1"
            style={{ color: "#555", background: "none", border: "none", cursor: "pointer", lineHeight: 1 } as React.CSSProperties}
          />
        </div>
      </div>
    </aside>
  );

  return (
    <div className="flex h-screen overflow-hidden" style={{ backgroundColor: "var(--bg-page)" }}>
      <SourcePanel source={activeSource} onClose={() => setActiveSource(null)} />
      {/* Sidebar — desktop */}
      <div className="hidden md:flex flex-col h-full">
        {sidebar}
      </div>

      {/* Sidebar — mobile overlay */}
      {sidebarOpen && (
        <div className="md:hidden fixed inset-0 z-40 flex">
          <div className="flex flex-col h-full" style={{ width: 256 }}>
            {sidebar}
          </div>
          <div
            className="flex-1"
            style={{ backgroundColor: "rgba(0,0,0,0.6)" }}
            onClick={() => setSidebarOpen(false)}
          />
        </div>
      )}

      {/* Main chat area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Mobile top bar */}
        <div
          className="md:hidden flex items-center gap-3 px-4 py-3"
          style={{ borderBottom: "1px solid var(--border-default)", backgroundColor: "var(--bg-surface)" }}
        >
          <button
            onClick={() => setSidebarOpen(true)}
            style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", padding: 4 }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>
          <span style={{ fontFamily: '"Barlow Condensed", sans-serif', fontWeight: 700, fontSize: 14, textTransform: "uppercase", letterSpacing: 1, color: "var(--text-primary)" }}>
            NEXUS SUPPORT
          </span>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-4 md:px-8 py-6 space-y-3">
          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full gap-8" style={{ maxWidth: 640, margin: "0 auto", width: "100%" }}>
              {/* Heading */}
              <div className="text-center">
                <div style={{ width: 36, height: 2, backgroundColor: "#98989A", margin: "0 auto 16px" }} />
                <p style={{ fontFamily: '"Barlow Condensed", sans-serif', fontWeight: 700, fontSize: 28, textTransform: "uppercase", letterSpacing: "-0.5px", color: "var(--text-primary)", lineHeight: 1.1 }}>
                  ¿EN QUÉ PUEDO<br />AYUDARTE?
                </p>
                <p className="mt-3 font-light" style={{ fontSize: 13, color: "var(--text-muted)", lineHeight: 1.65 }}>
                  Pregunta sobre configuración, procesos o funciones de TotalDealer.
                </p>
              </div>

              {/* Suggestion cards */}
              {suggestions.length > 0 && (
                <div className="grid grid-cols-1 gap-2 w-full" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))" }}>
                  {suggestions.map((s, i) => (
                    <button
                      key={i}
                      onClick={() => sendText(s.prompt)}
                      className="text-left px-4 py-3 transition-colors"
                      style={{
                        backgroundColor: "var(--bg-surface)",
                        border: "1px solid var(--border-default)",
                        color: "var(--text-primary)",
                        cursor: "pointer",
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.borderColor = "var(--text-muted)")}
                      onMouseLeave={(e) => (e.currentTarget.style.borderColor = "var(--border-default)")}
                    >
                      <span style={{ fontFamily: '"Barlow Condensed", sans-serif', fontWeight: 700, fontSize: 11, letterSpacing: "1px", textTransform: "uppercase", color: "var(--text-muted)", display: "block", marginBottom: 4 }}>
                        {s.label}
                      </span>
                      <span style={{ fontSize: 13, color: "var(--text-primary)", lineHeight: 1.4 }}>
                        {s.prompt}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {messages.map((msg, i) => (
            <MessageBubble
              key={i}
              message={msg}
              onFollowUp={
                i === messages.length - 1 && msg.role === "assistant" && !sending
                  ? (text) => { sendText(text); }
                  : undefined
              }
              onOpenSource={(pdf) => setActiveSource(pdf)}
            />
          ))}

          {sending && (
            <div className="flex justify-start">
              <div className="px-4 py-3" style={{ backgroundColor: "var(--bubble-ai-bg)", border: "1px solid var(--bubble-ai-border)" }}>
                <div className="flex space-x-1.5 items-center h-4">
                  {[0, 150, 300].map((d) => (
                    <span
                      key={d}
                      className="w-1.5 h-1.5 rounded-full animate-bounce"
                      style={{ backgroundColor: "var(--text-muted)", animationDelay: `${d}ms` }}
                    />
                  ))}
                </div>
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        {/* Input bar */}
        <div
          className="px-4 md:px-8 py-4"
          style={{ borderTop: "1px solid var(--border-default)", backgroundColor: "var(--bg-surface)" }}
        >
          <form onSubmit={handleSend} className="flex gap-2 max-w-3xl mx-auto items-end">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Escribe tu pregunta sobre TotalDealer..."
              disabled={sending}
              rows={1}
              className="flex-1 px-3 py-2.5 text-sm font-light focus:outline-none resize-none transition-colors"
              style={{
                backgroundColor: "var(--input-bg)",
                border: "1px solid var(--input-border)",
                color: "var(--text-primary)",
                maxHeight: 120,
                lineHeight: 1.5,
              }}
              onFocus={(e) => (e.target.style.borderColor = "var(--input-focus)")}
              onBlur={(e) => (e.target.style.borderColor = "var(--input-border)")}
              onInput={(e) => {
                const t = e.currentTarget;
                t.style.height = "auto";
                t.style.height = Math.min(t.scrollHeight, 120) + "px";
              }}
            />
            <button
              type="submit"
              disabled={sending || !input.trim()}
              className="px-5 py-2.5 transition-colors disabled:opacity-40 shrink-0"
              style={{
                fontFamily: '"Barlow Condensed", sans-serif',
                fontWeight: 700,
                fontSize: 11,
                letterSpacing: "2px",
                textTransform: "uppercase",
                backgroundColor: "var(--btn-primary-bg)",
                color: "var(--btn-primary-text)",
                border: "none",
                cursor: sending || !input.trim() ? "not-allowed" : "pointer",
              }}
              onMouseEnter={(e) => { if (!sending && input.trim()) e.currentTarget.style.backgroundColor = "var(--btn-primary-hover)"; }}
              onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "var(--btn-primary-bg)")}
            >
              Enviar
            </button>
          </form>
          <p className="text-center mt-1.5" style={{ fontSize: 10, color: "var(--text-faint)", fontFamily: '"Barlow Condensed", sans-serif', letterSpacing: 1 }}>
            Enter para enviar · Shift+Enter para nueva línea
          </p>
        </div>
      </div>
    </div>
  );
}
