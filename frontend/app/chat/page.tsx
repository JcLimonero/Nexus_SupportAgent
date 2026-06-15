"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/AuthProvider";
import { localLogout } from "@/lib/auth";
import { sendMessageStream, getSessions, getSessionMessages, getSuggestions, renameSession, deleteSession, submitFeedback } from "@/lib/api";
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
  const [isStreaming, setIsStreaming]         = useState(false);
  const bottomRef  = useRef<HTMLDivElement>(null);
  const inputRef   = useRef<HTMLTextAreaElement>(null);
  const abortRef   = useRef<AbortController | null>(null);

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

  const handleOpenVideo = useCallback((video: { file_name: string; gcs_url: string }) => {
    setActiveSource({ chunk_id: undefined, file_name: video.file_name, page_number: null, gcs_url: video.gcs_url });
  }, []);

  // Stable reference — identified by message ID, not index, so memo on MessageBubble
  // skips re-renders for all past messages during streaming.
  const handleFeedback = useCallback(async (msgId: string, rating: "up" | "down") => {
    setMessages((prev) =>
      prev.map((m) => m.id === msgId ? { ...m, feedback: rating } : m)
    );
    try { await submitFeedback(msgId, rating); } catch { /* silent */ }
  }, []);

  const handleRetry = () => {
    if (sending || messages.length < 2) return;
    const lastUserIdx = messages.map((m) => m.role).lastIndexOf("user");
    if (lastUserIdx === -1) return;
    const userText = messages[lastUserIdx].content;
    setMessages((prev) => prev.slice(0, lastUserIdx));
    sendText(userText);
  };

  // Clicking a related/follow-up question pauses briefly then types the answer
  // out word by word, so it reads like the assistant is replying live.
  const handleFollowUp = (text: string) => sendText(text, { typewriter: true, delayMs: 1000 });

  const handleLogout = () => {
    localLogout();
    refresh();
    router.push("/");
  };

  const stopStreaming = () => {
    abortRef.current?.abort();
  };

  const sendText = async (
    text: string,
    opts?: { typewriter?: boolean; delayMs?: number },
  ) => {
    if (!text || sending) return;
    const typewriter = opts?.typewriter ?? false;
    const controller = new AbortController();
    abortRef.current = controller;
    setSending(true);
    setIsStreaming(false);
    setMessages((p) => [
      ...p,
      { role: "user", content: text },
      { role: "assistant", content: "", sources: { pdfs: [], videos: [] }, follow_ups: [] },
    ]);

    const appendToLast = (chunk: string) => {
      setMessages((prev) => {
        const updated = [...prev];
        const last = updated[updated.length - 1];
        if (last?.role === "assistant") {
          updated[updated.length - 1] = { ...last, content: last.content + chunk };
        }
        return updated;
      });
    };
    const setLastContent = (content: string) => {
      setMessages((prev) => {
        const updated = [...prev];
        const last = updated[updated.length - 1];
        if (last?.role === "assistant") {
          updated[updated.length - 1] = { ...last, content };
        }
        return updated;
      });
    };

    // Typewriter reveal: the rendered answer is always a growing word-by-word
    // prefix of `fullText`. Tokens (even a whole cached answer in one chunk)
    // append to fullText; the reveal loop is the *sole* writer of content, so
    // it never jumps — it walks the prefix forward at a steady cadence until it
    // catches up to the final authoritative answer.
    const REVEAL_CHARS = 4;   // chars revealed per tick
    const REVEAL_TICK = 14;   // ms between ticks (~285 chars/s)
    let fullText = "";
    let revealed = 0;
    let streamDone = false;
    let revealPromise: Promise<void> | null = null;
    const startReveal = () => {
      revealPromise = (async () => {
        while (!controller.signal.aborted) {
          if (revealed >= fullText.length) {
            if (streamDone) break;
            await new Promise((r) => setTimeout(r, 16));
            continue;
          }
          revealed = Math.min(fullText.length, revealed + REVEAL_CHARS);
          setLastContent(fullText.slice(0, revealed));
          await new Promise((r) => setTimeout(r, REVEAL_TICK));
        }
      })();
    };

    // Optional pause before answering so it feels like the assistant is composing.
    if (opts?.delayMs) {
      await new Promise((r) => setTimeout(r, opts.delayMs));
      if (controller.signal.aborted) {
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          return last?.role === "assistant" && last.content === "" ? prev.slice(0, -1) : prev;
        });
        abortRef.current = null;
        setSending(false);
        return;
      }
    }

    try {
      for await (const event of sendMessageStream(text, currentSessionId, controller.signal)) {
        if ("token" in event) {
          setIsStreaming(true);
          if (typewriter) {
            fullText += event.token;
            if (!revealPromise) startReveal();
          } else {
            appendToLast(event.token);
          }
        } else if ("done" in event && event.done) {
          const aborted = controller.signal.aborted;
          if (typewriter) {
            // event.answer is authoritative; let the reveal walk to its end so
            // there is never an abrupt jump to the full text.
            if (!aborted) fullText = event.answer;
            streamDone = true;
            if (revealPromise) await revealPromise;
          }
          setCurrentSessionId(event.session_id);
          setMessages((prev) => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last?.role === "assistant") {
              updated[updated.length - 1] = {
                ...last,
                id: event.message_id,
                // In typewriter mode the reveal loop already wrote the content;
                // keep it (and whatever was revealed if the user hit stop).
                content: typewriter || aborted ? last.content : event.answer,
                sources: {
                  pdfs: event.pdf_sources as PdfSource[],
                  videos: event.video_sources as Array<{ file_name: string; gcs_url: string }>,
                },
                follow_ups: aborted ? last.follow_ups : event.follow_ups,
              };
            }
            return updated;
          });
          loadSessions();
        }
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        setMessages((prev) => {
          const updated = [...prev];
          const last = updated[updated.length - 1];
          if (last?.role === "assistant" && last.content === "") {
            return updated.slice(0, -1);
          }
          return updated;
        });
      } else {
        setMessages((prev) => {
          const updated = [...prev];
          const last = updated[updated.length - 1];
          if (last?.role === "assistant") {
            updated[updated.length - 1] = {
              ...last,
              content: "Ocurrió un error. Por favor intenta de nuevo.",
            };
          }
          return updated;
        });
      }
    } finally {
      abortRef.current = null;
      setSending(false);
      setIsStreaming(false);
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
      <div className="px-5 py-5" style={{ borderBottom: "1px solid #1e3a5f" }}>
        <Image
          src="/brand/nqt-logo-white.png"
          alt="Nexus Q Tech"
          width={160}
          height={58}
          priority
          unoptimized
          style={{ display: "block", width: 160, height: "auto" }}
        />
        <div style={{ fontFamily: '"Barlow Condensed", sans-serif', fontWeight: 500, fontSize: 9, color: "#0ea5e9", textTransform: "uppercase", letterSpacing: "2.5px", marginTop: 8 }}>
          Soporte · TotalDealer
        </div>
      </div>

      {/* New chat */}
      <div className="px-4 py-3" style={{ borderBottom: "1px solid #1e3a5f" }}>
        <button
          onClick={newChat}
          className="w-full py-2.5 px-3 text-center transition-colors"
          style={{
            fontFamily: '"Barlow Condensed", sans-serif',
            fontWeight: 700,
            fontSize: 11,
            letterSpacing: "2px",
            textTransform: "uppercase",
            backgroundColor: "var(--btn-primary-bg)",
            color: "var(--btn-primary-text)",
            border: "none",
            borderRadius: "var(--radius-sm)",
            cursor: "pointer",
            animation: sessions.length === 0 ? "nqt-glowPulse 2.2s ease-in-out infinite" : undefined,
          }}
          onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "var(--btn-primary-hover)")}
          onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "var(--btn-primary-bg)")}
        >
          + NUEVA CONVERSACIÓN
        </button>
      </div>

      {/* Session list */}
      <nav className="flex-1 overflow-y-auto py-2">
        {sessions.length === 0 && (
          <p style={{ padding: "12px 16px", fontSize: 10, color: "#2d5282", fontFamily: '"Barlow Condensed", sans-serif', letterSpacing: 1, textTransform: "uppercase" }}>
            Sin conversaciones
          </p>
        )}
        {sessions.map((s) => (
          <div
            key={s.id}
            className="group relative"
            style={{
              backgroundColor: currentSessionId === s.id ? "var(--bg-sidebar-active)" : "transparent",
              borderLeft: currentSessionId === s.id ? "2px solid var(--nqt-blue, #0ea5e9)" : "2px solid transparent",
            }}
            onMouseEnter={(e) => {
              if (currentSessionId !== s.id) e.currentTarget.style.backgroundColor = "var(--bg-sidebar-hover)";
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
                  background: "#0d2137",
                  color: "#e2e8f0",
                  border: "none",
                  borderBottom: "1px solid #0ea5e9",
                }}
              />
            ) : deletingId === s.id ? (
              /* Delete confirmation */
              <div className="px-4 py-2.5">
                <p style={{ fontFamily: '"Barlow Condensed", sans-serif', fontSize: 10, letterSpacing: 1, textTransform: "uppercase", color: "#fca5a5", marginBottom: 6 }}>
                  ¿Eliminar conversación?
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={() => confirmDelete(s.id)}
                    style={{ fontFamily: '"Barlow Condensed", sans-serif', fontSize: 10, letterSpacing: 1, textTransform: "uppercase", background: "#ef4444", color: "#fff", border: "none", cursor: "pointer", padding: "3px 8px", borderRadius: "var(--radius-sm)" }}
                  >
                    Eliminar
                  </button>
                  <button
                    onClick={() => setDeletingId(null)}
                    style={{ fontFamily: '"Barlow Condensed", sans-serif', fontSize: 10, letterSpacing: 1, textTransform: "uppercase", background: "transparent", color: "#64748b", border: "1px solid #1e3a5f", cursor: "pointer", padding: "3px 8px", borderRadius: "var(--radius-sm)" }}
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
                <span style={{ fontFamily: '"Barlow Condensed", sans-serif', fontSize: 12, color: currentSessionId === s.id ? "#ffffff" : "#94a3b8", display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {s.title ?? fmt(s.created_at)}
                </span>
                <span style={{ fontFamily: '"Barlow Condensed", sans-serif', fontSize: 10, letterSpacing: "0.5px", textTransform: "uppercase", color: "#2d5282", display: "block" }}>
                  {fmt(s.created_at)}
                </span>
              </button>
            )}

            {/* Action icons — visible on hover when not editing/deleting */}
            {editingId !== s.id && deletingId !== s.id && (
              <div className="absolute right-2 top-1/2 -translate-y-1/2 hidden group-hover:flex gap-1">
                {/* Rename */}
                <button
                  onClick={(e) => { e.stopPropagation(); startEdit(s); }}
                  title="Renombrar"
                  style={{ background: "none", border: "none", cursor: "pointer", color: "#2d5282", padding: 4, lineHeight: 1 }}
                  onMouseEnter={(e) => (e.currentTarget.style.color = "#94a3b8")}
                  onMouseLeave={(e) => (e.currentTarget.style.color = "#2d5282")}
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
                  style={{ background: "none", border: "none", cursor: "pointer", color: "#2d5282", padding: 4, lineHeight: 1 }}
                  onMouseEnter={(e) => (e.currentTarget.style.color = "#f87171")}
                  onMouseLeave={(e) => (e.currentTarget.style.color = "#2d5282")}
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
      <div className="px-4 py-4 space-y-2" style={{ borderTop: "1px solid #1e3a5f" }}>
        {user && (
          <p style={{ fontSize: 10, color: "#2d5282", fontFamily: '"Barlow Condensed", sans-serif', letterSpacing: 1, textTransform: "uppercase", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {user.email}
          </p>
        )}
        {user?.is_admin && (
          <button
            onClick={() => router.push("/admin")}
            className="w-full py-2 px-3 text-center transition-colors"
            style={{
              fontFamily: '"Barlow Condensed", sans-serif',
              fontWeight: 600,
              fontSize: 10,
              letterSpacing: "2px",
              textTransform: "uppercase",
              backgroundColor: "#0d2137",
              color: "#64748b",
              border: "1px solid #1e3a5f",
              borderRadius: "var(--radius-sm)",
              cursor: "pointer",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = "#112d4e"; e.currentTarget.style.color = "#94a3b8"; }}
            onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "#0d2137"; e.currentTarget.style.color = "#64748b"; }}
          >
            Administrar documentos
          </button>
        )}
        <div className="flex items-center justify-between pt-1">
          <button
            onClick={handleLogout}
            style={{ fontSize: 10, color: "#2d5282", fontFamily: '"Barlow Condensed", sans-serif', letterSpacing: 1, textTransform: "uppercase", background: "none", border: "none", cursor: "pointer" }}
            onMouseEnter={(e) => (e.currentTarget.style.color = "#64748b")}
            onMouseLeave={(e) => (e.currentTarget.style.color = "#2d5282")}
          >
            Cerrar sesión
          </button>
          <ThemeToggle
            className="transition-colors p-1"
            style={{ color: "#2d5282", background: "none", border: "none", cursor: "pointer", lineHeight: 1 } as React.CSSProperties}
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
        <div className="md:hidden fixed inset-0 z-40 flex" style={{ animation: "nqt-fadeIn 0.2s ease both" }}>
          <div className="flex flex-col h-full" style={{ width: 256, animation: "nqt-slideInLeft 0.3s cubic-bezier(0.16, 1, 0.3, 1) both" }}>
            {sidebar}
          </div>
          <div
            className="flex-1"
            style={{ backgroundColor: "rgba(5,15,26,0.7)" }}
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
                <div style={{ width: 36, height: 3, background: "linear-gradient(90deg, #0ea5e9, #06b6d4)", margin: "0 auto 16px", borderRadius: 2 }} />
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
                      className="text-left px-4 py-3 transition-all"
                      style={{
                        backgroundColor: "var(--bg-surface)",
                        border: "1px solid var(--border-default)",
                        borderLeft: "3px solid var(--nqt-blue, #0ea5e9)",
                        color: "var(--text-primary)",
                        cursor: "pointer",
                        borderRadius: "2px var(--radius) var(--radius) 2px",
                        animation: "nqt-slideUp 0.35s ease both",
                        animationDelay: `${i * 75}ms`,
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.backgroundColor = "rgba(14,165,233,0.04)";
                        e.currentTarget.style.borderColor = "var(--nqt-blue, #0ea5e9)";
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.backgroundColor = "var(--bg-surface)";
                        e.currentTarget.style.borderColor = "var(--border-default)";
                        e.currentTarget.style.borderLeftColor = "var(--nqt-blue, #0ea5e9)";
                      }}
                    >
                      <span style={{ fontFamily: '"Barlow Condensed", sans-serif', fontWeight: 700, fontSize: 11, letterSpacing: "1px", textTransform: "uppercase", color: "var(--nqt-blue, #0ea5e9)", display: "block", marginBottom: 4 }}>
                        {s.label}
                      </span>
                      <span style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.4, fontWeight: 300 }}>
                        {s.prompt}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {messages.map((msg, i) => {
            if (sending && !isStreaming && msg.role === "assistant" && msg.content === "" && i === messages.length - 1) {
              return null;
            }
            const isLastAssistant = i === messages.length - 1 && msg.role === "assistant";
            const isCompleted = !sending && isLastAssistant;
            return (
              <div
                key={i}
                style={{
                  animation: "nqt-slideUp 0.28s ease both",
                  animationDelay: `${Math.min(i, 6) * 35}ms`,
                }}
              >
                <MessageBubble
                  message={msg}
                  streaming={isStreaming && isLastAssistant}
                  onFollowUp={isCompleted ? handleFollowUp : undefined}
                  onOpenSource={setActiveSource}
                  onOpenVideo={handleOpenVideo}
                  onFeedback={msg.role === "assistant" && !sending && msg.content ? handleFeedback : undefined}
                  onRetry={isCompleted ? handleRetry : undefined}
                />
              </div>
            );
          })}

          {sending && !isStreaming && (
            <div className="flex justify-start">
              <div
                className="px-4 py-3"
                style={{
                  backgroundColor: "var(--bubble-ai-bg)",
                  border: "1px solid var(--bubble-ai-border)",
                  borderLeft: "3px solid var(--nqt-blue, #0ea5e9)",
                  borderRadius: "2px var(--radius) var(--radius) var(--radius)",
                }}
              >
                <div className="flex space-x-1.5 items-center h-4">
                  {[0, 150, 300].map((d) => (
                    <span
                      key={d}
                      className="w-1.5 h-1.5 rounded-full animate-bounce"
                      style={{ backgroundColor: "var(--nqt-blue, #0ea5e9)", animationDelay: `${d}ms`, opacity: 0.7 }}
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
                borderRadius: "var(--radius)",
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
            {sending ? (
              <button
                type="button"
                onClick={stopStreaming}
                className="px-5 py-2.5 shrink-0 transition-colors"
                style={{
                  fontFamily: '"Barlow Condensed", sans-serif',
                  fontWeight: 700,
                  fontSize: 11,
                  letterSpacing: "2px",
                  textTransform: "uppercase",
                  backgroundColor: "#0d2137",
                  color: "#94a3b8",
                  border: "1px solid #1e3a5f",
                  borderRadius: "var(--radius)",
                  cursor: "pointer",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = "#112d4e"; e.currentTarget.style.color = "#e2e8f0"; }}
                onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "#0d2137"; e.currentTarget.style.color = "#94a3b8"; }}
              >
                Detener
              </button>
            ) : (
              <button
                type="submit"
                disabled={!input.trim()}
                className="btn-send px-5 py-2.5 transition-colors disabled:opacity-40 shrink-0"
                style={{
                  fontFamily: '"Barlow Condensed", sans-serif',
                  fontWeight: 700,
                  fontSize: 11,
                  letterSpacing: "2px",
                  textTransform: "uppercase",
                  backgroundColor: "var(--btn-primary-bg)",
                  color: "var(--btn-primary-text)",
                  border: "none",
                  borderRadius: "var(--radius)",
                  cursor: !input.trim() ? "not-allowed" : "pointer",
                }}
                onMouseEnter={(e) => { if (input.trim()) e.currentTarget.style.backgroundColor = "var(--btn-primary-hover)"; }}
                onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "var(--btn-primary-bg)")}
              >
                Enviar
              </button>
            )}
          </form>
          <p className="text-center mt-1.5" style={{ fontSize: 10, color: "var(--text-faint)", fontFamily: '"Barlow Condensed", sans-serif', letterSpacing: 1 }}>
            {sending ? "Generando respuesta · Detener para cancelar" : "Enter para enviar · Shift+Enter para nueva línea"}
          </p>
        </div>
      </div>
    </div>
  );
}
