"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/AuthProvider";
import { localLogout } from "@/lib/auth";
import { sendMessageStream, getSessions, getSessionMessages, getSuggestions, submitFeedback, shareSession, NO_INFO_PREFIX } from "@/lib/api";
import { useToast } from "@/components/Toast";
import { MessageBubble, type Message, type PdfSource, type MediaSource } from "@/components/MessageBubble";
import { SourcePanel } from "@/components/SourcePanel";
import { SessionSidebar, type Session } from "@/components/SessionSidebar";
import { ThemeToggle } from "@/components/ThemeToggle";
import { BrandLogo } from "@/components/BrandLogo";
import { EscalateModal } from "@/components/EscalateModal";
import { useServiceStatus } from "@/components/ServiceStatus";

export default function ChatPage() {
  const { user, loading, refresh } = useAuth();
  const router = useRouter();
  const { toast } = useToast();
  // A live blocking banner (or an unreachable backend) pauses sending.
  const { chatBlocked, reportServiceError } = useServiceStatus();
  const [sharing, setSharing] = useState(false);
  const [sessions, setSessions]               = useState<Session[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [messages, setMessages]               = useState<Message[]>([]);
  const [input, setInput]                     = useState("");
  const [sending, setSending]                 = useState(false);
  const [sidebarOpen, setSidebarOpen]         = useState(false);
  const [activeSource, setActiveSource]       = useState<PdfSource | null>(null);
  const [suggestions, setSuggestions]         = useState<{ label: string; prompt: string }[]>([]);
  const [isStreaming, setIsStreaming]         = useState(false);
  const [escalateOpen, setEscalateOpen]       = useState(false);
  const [atBottom, setAtBottom]               = useState(true);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const bottomRef  = useRef<HTMLDivElement>(null);
  const inputRef   = useRef<HTMLTextAreaElement>(null);
  const abortRef   = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!loading && !user) router.push("/");
  }, [user, loading, router]);

  const isGuest = !!user?.is_anon;

  useEffect(() => {
    if (user) {
      // Guests have no persisted history sidebar — skip loading sessions.
      if (!user.is_anon) loadSessions();
      getSuggestions().then(setSuggestions);
    }
  }, [user]);

  // Auto-scroll only when the user is already at the bottom, so a stream never
  // yanks them down while they're reading earlier content.
  useEffect(() => {
    if (atBottom) bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, sending, atBottom]);

  const handleMessagesScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
  };

  const scrollToBottom = () => {
    setAtBottom(true);
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  // Desktop sidebar collapse preference (persisted; mobile uses the overlay).
  useEffect(() => {
    setSidebarCollapsed(localStorage.getItem("sidebarCollapsed") === "1");
  }, []);

  const toggleSidebarCollapsed = () => {
    setSidebarCollapsed((c) => {
      const next = !c;
      localStorage.setItem("sidebarCollapsed", next ? "1" : "0");
      return next;
    });
  };

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

  const handleOpenVideo = useCallback((video: MediaSource) => {
    setActiveSource({
      chunk_id: video.chunk_id,
      file_name: video.file_name,
      page_number: null,
      gcs_url: video.gcs_url,
      source_type: video.source_type,
      start_time: video.start_time,
    });
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

  // Clicking a suggested or related/follow-up question pauses briefly then
  // types the answer out word by word, so it reads like the assistant is
  // replying live.
  const handleQuestionClick = (text: string) => sendText(text, { typewriter: true, delayMs: 1000 });

  const handleLogout = () => {
    localLogout();
    refresh();
    router.push("/");
  };

  const handleShare = async () => {
    if (!currentSessionId || sharing) return;
    setSharing(true);
    try {
      const { path } = await shareSession(currentSessionId);
      const url = `${window.location.origin}${path}`;
      await navigator.clipboard.writeText(url);
      toast("Enlace copiado. Cualquiera con el enlace podrá ver esta conversación.", "success");
    } catch {
      toast("No se pudo crear el enlace para compartir.", "error");
    } finally {
      setSharing(false);
    }
  };

  const stopStreaming = () => {
    abortRef.current?.abort();
  };

  const sendText = async (
    text: string,
    opts?: { typewriter?: boolean; delayMs?: number },
  ) => {
    // Also guards suggestion / follow-up / retry clicks, which bypass the input.
    if (!text || sending || chatBlocked) return;
    let typewriter = opts?.typewriter ?? false;
    const controller = new AbortController();
    abortRef.current = controller;
    setSending(true);
    setIsStreaming(false);
    setMessages((p) => [
      ...p,
      { role: "user", content: text, created_at: new Date().toISOString() },
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

    // An `error` frame ends the stream without a `done`, and a dropped
    // connection never reaches one either — so this is the only chance to stop
    // the reveal loop (it polls forever otherwise) and fill the empty bubble.
    const failLast = async (detail?: string) => {
      streamDone = true;
      if (revealPromise) await revealPromise;
      const reason = detail?.trim().replace(/[.\s]+$/, "") || "Ocurrió un error";
      const notice = `${reason}. Por favor intenta de nuevo.`;
      setMessages((prev) => {
        const updated = [...prev];
        const last = updated[updated.length - 1];
        if (last?.role === "assistant") {
          updated[updated.length - 1] = {
            ...last,
            // Keep whatever already streamed — a partial answer the user watched
            // arrive is less confusing than text that vanishes on failure.
            content: last.content
              ? `${last.content}\n\n*La respuesta quedó incompleta. ${notice}*`
              : notice,
          };
        }
        return updated;
      });
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
          // Cached answers arrive whole in one chunk — switch to the
          // typewriter reveal so they still read like the assistant typing
          // instead of popping in instantly.
          if (event.from_cache) typewriter = true;
          if (typewriter) {
            fullText += event.token;
            if (!revealPromise) startReveal();
          } else {
            appendToLast(event.token);
          }
        } else if ("error" in event) {
          reportServiceError();
          await failLast(event.error);
          break;
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
                  videos: event.video_sources as MediaSource[],
                },
                follow_ups: aborted ? last.follow_ups : event.follow_ups,
                created_at: last.created_at ?? new Date().toISOString(),
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
        // Network drop or 5xx — have the status banner re-check right away.
        reportServiceError();
        await failLast();
      }
    } finally {
      abortRef.current = null;
      setSending(false);
      setIsStreaming(false);
      inputRef.current?.focus();
    }
  };

  const handleSessionDeleted = (id: string) => {
    if (currentSessionId === id) {
      setCurrentSessionId(null);
      setMessages([]);
    }
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
      <div className="flex flex-1 items-center justify-center" style={{ backgroundColor: "var(--bg-page)" }}>
        <span className="nqt-label">Cargando...</span>
      </div>
    );
  }

  // Support requests need a real account — there's no way to follow up with a
  // guest beyond what they type, and the backend rejects them anyway.
  const canEscalate = !!user && !user.is_anon;
  const canSend = !!input.trim() && !chatBlocked;
  // Auto-offer human contact when the assistant just said it has no info.
  const lastMsg = messages[messages.length - 1];
  const showEscalateOffer =
    canEscalate && !sending && lastMsg?.role === "assistant" && lastMsg.content.startsWith(NO_INFO_PREFIX);
  const lastUserQuestion = [...messages].reverse().find((m) => m.role === "user")?.content;
  const defaultEmail = canEscalate ? user?.email : undefined;

  const sidebar = (
    <SessionSidebar
      user={user}
      sessions={sessions}
      setSessions={setSessions}
      currentSessionId={currentSessionId}
      onOpenSession={openSession}
      onNewChat={newChat}
      onLogout={handleLogout}
      onToggleCollapsed={toggleSidebarCollapsed}
      onDeleted={handleSessionDeleted}
    />
  );

  return (
    <div className="flex flex-1 min-h-0 overflow-hidden" style={{ backgroundColor: "var(--bg-page)" }}>
      <SourcePanel source={activeSource} onClose={() => setActiveSource(null)} />
      <EscalateModal
        open={escalateOpen}
        onClose={() => setEscalateOpen(false)}
        sessionId={currentSessionId}
        defaultEmail={defaultEmail}
        defaultReason={lastUserQuestion}
      />
      {/* Sidebar — desktop (hidden for guests, or when collapsed) */}
      {!isGuest && !sidebarCollapsed && (
        <div className="hidden md:flex flex-col h-full">
          {sidebar}
        </div>
      )}

      {/* Sidebar — mobile overlay */}
      {!isGuest && sidebarOpen && (
        <div className="md:hidden fixed inset-0 z-40 flex" style={{ animation: "nqt-fadeIn 0.2s ease both" }}>
          <div className="flex flex-col h-full" style={{ width: 272, animation: "nqt-slideInLeft 0.3s cubic-bezier(0.16, 1, 0.3, 1) both" }}>
            {sidebar}
          </div>
          <div
            className="flex-1"
            style={{ backgroundColor: "var(--overlay)" }}
            onClick={() => setSidebarOpen(false)}
          />
        </div>
      )}

      {/* Main chat area */}
      <div className="flex-1 flex flex-col min-w-0 relative">
        {/* Reopen sidebar (desktop only, shown when collapsed) */}
        {!isGuest && sidebarCollapsed && (
          <button
            onClick={toggleSidebarCollapsed}
            aria-label="Mostrar barra lateral"
            title="Mostrar barra lateral"
            className="hidden md:flex"
            style={{
              position: "absolute", top: 10, left: 10, zIndex: 30,
              alignItems: "center", justifyContent: "center", width: 34, height: 34,
              borderRadius: "var(--radius-sm)", backgroundColor: "var(--bg-surface)",
              border: "1px solid var(--border-default)", color: "var(--text-muted)",
              boxShadow: "var(--shadow-sm)", cursor: "pointer",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--accent-fg)"; e.currentTarget.style.borderColor = "var(--accent)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; e.currentTarget.style.borderColor = "var(--border-default)"; }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>
        )}
        {/* Guest top bar — shown on all sizes (guests have no sidebar) */}
        {isGuest ? (
          <div
            className="flex items-center gap-2 sm:gap-3 px-4 md:px-8 py-3"
            style={{ borderBottom: "1px solid var(--border-default)", backgroundColor: "var(--bg-header)", backdropFilter: "blur(16px)" }}
          >
            <BrandLogo height={26} className="sm:hidden" />
            <BrandLogo height={30} className="hidden sm:inline-flex" />
            <span className="hidden md:inline" style={{ fontWeight: 600, fontSize: 14, color: "var(--text-secondary)", paddingLeft: 12, borderLeft: "1px solid var(--border-default)" }}>
              Asistente de soporte
            </span>
            <span
              style={{
                fontWeight: 600, fontSize: 12, color: "var(--accent-fg)", backgroundColor: "var(--accent-tint)",
                borderRadius: "var(--radius-pill)", padding: "3px 10px", whiteSpace: "nowrap",
              }}
            >
              Modo invitado
            </span>
            <div className="flex items-center gap-2" style={{ marginLeft: "auto" }}>
              <button onClick={handleLogout} className="nqt-btn nqt-btn--sm nqt-btn--ghost">
                Iniciar sesión
              </button>
              <ThemeToggle className="nqt-iconbtn" />
            </div>
          </div>
        ) : (
          /* Mobile top bar */
          <div
            className="md:hidden flex items-center gap-3 px-4 py-3"
            style={{ borderBottom: "1px solid var(--border-default)", backgroundColor: "var(--bg-header)" }}
          >
            <button
              onClick={() => setSidebarOpen(true)}
              aria-label="Abrir menú de conversaciones"
              className="nqt-iconbtn"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" />
              </svg>
            </button>
            <BrandLogo height={26} />
          </div>
        )}

        {/* Actions toolbar — help requests need an account; share needs a saved session */}
        {(canEscalate || (currentSessionId && messages.length > 0)) && (
        <div
          className={`flex items-center gap-2 px-4 md:px-8 py-2.5 ${canEscalate ? "justify-between" : "justify-end"}`}
          style={{ borderBottom: "1px solid var(--border-default)", backgroundColor: "var(--bg-surface)" }}
        >
          {canEscalate && (
          <button
            onClick={() => setEscalateOpen(true)}
            title="Solicitar ayuda de una persona del equipo de soporte"
            className="nqt-btn nqt-btn--sm nqt-btn--ghost"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>
              <path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>
            </svg>
            Solicitar ayuda
          </button>
          )}
          {currentSessionId && messages.length > 0 && (
            <button
              onClick={handleShare}
              disabled={sharing}
              title="Copiar enlace público a esta conversación"
              className="nqt-btn nqt-btn--sm nqt-btn--ghost"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
                <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
              </svg>
              {sharing ? "Generando..." : "Compartir"}
            </button>
          )}
        </div>
        )}

        {/* Messages — live region so screen readers announce streamed replies
            (polite + non-atomic so only new content is read, not the whole log) */}
        <div
          className="flex-1 overflow-y-auto px-4 md:px-8 py-6 space-y-3"
          onScroll={handleMessagesScroll}
          role="log"
          aria-live="polite"
          aria-atomic="false"
          aria-relevant="additions text"
        >
          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center min-h-full gap-8 py-4" style={{ maxWidth: 680, margin: "0 auto", width: "100%" }}>
              {/* Heading — TotalDealer pattern: navy headline, key word in orange */}
              <div className="text-center">
                <p className="td-eyebrow">Asistente TotalDealer</p>
                <h1 style={{ fontWeight: 700, fontSize: 34, letterSpacing: "-0.03em", color: "var(--text-primary)", lineHeight: 1.15, marginTop: 10 }}>
                  ¿En qué puedo <span style={{ color: "var(--accent-fg)" }}>ayudarte</span>?
                </h1>
                <p className="mt-3" style={{ fontSize: 15, color: "var(--text-muted)", lineHeight: 1.6 }}>
                  Pregunta sobre configuración, procesos o funciones de TotalDealer.
                </p>
              </div>

              {/* Suggestion cards — cap at 4 so the welcome block stays vertically centered */}
              {suggestions.length > 0 && (
                <div className="grid grid-cols-1 gap-3 w-full" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))" }}>
                  {suggestions.slice(0, 4).map((s, i) => (
                    <button
                      key={i}
                      onClick={() => handleQuestionClick(s.prompt)}
                      className="td-suggestion text-left"
                      style={{ animationDelay: `${i * 75}ms` }}
                    >
                      <span className="td-suggestion__label">{s.label}</span>
                      <span className="td-suggestion__prompt">{s.prompt}</span>
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
                // Key by message id once the server assigns it — index keys
                // remount every bubble on retry/slice, defeating the memo.
                key={msg.id ?? `idx-${i}`}
                style={{
                  animation: "nqt-slideUp 0.28s ease both",
                  animationDelay: `${Math.min(i, 6) * 35}ms`,
                }}
              >
                <MessageBubble
                  message={msg}
                  streaming={isStreaming && isLastAssistant}
                  onFollowUp={isCompleted ? handleQuestionClick : undefined}
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
                  borderRadius: "6px var(--radius-lg) var(--radius-lg) var(--radius-lg)",
                  boxShadow: "var(--shadow-sm)",
                }}
              >
                <div className="flex space-x-1.5 items-center h-4">
                  {[0, 150, 300].map((d) => (
                    <span
                      key={d}
                      className="w-1.5 h-1.5 rounded-full animate-bounce"
                      style={{ backgroundColor: "var(--accent-bright)", animationDelay: `${d}ms`, opacity: 0.8 }}
                    />
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Auto-offer human contact right after a "no info" answer */}
          {showEscalateOffer && (
            <div
              className="flex justify-start"
              style={{ animation: "nqt-slideUp 0.3s ease both" }}
            >
              <div
                className="px-5 py-4"
                style={{
                  backgroundColor: "var(--bg-surface)",
                  border: "1px solid var(--accent-border)",
                  borderRadius: "var(--radius-lg)",
                  boxShadow: "var(--shadow)",
                  maxWidth: 420,
                }}
              >
                <p style={{ fontSize: 14, color: "var(--text-secondary)", lineHeight: 1.5, marginBottom: 12 }}>
                  ¿Prefieres que te ayude una persona del equipo de soporte?
                </p>
                <button onClick={() => setEscalateOpen(true)} className="nqt-btn nqt-btn--sm nqt-btn--primary">
                  Solicitar ayuda
                </button>
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        {/* Scroll-to-bottom — shown when the user has scrolled up from the latest reply */}
        {!atBottom && messages.length > 0 && (
          <button
            onClick={scrollToBottom}
            aria-label="Ir a la respuesta más reciente"
            title="Ir abajo"
            style={{
              position: "absolute",
              bottom: 104,
              left: "50%",
              transform: "translateX(-50%)",
              zIndex: 20,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 36,
              height: 36,
              borderRadius: "50%",
              backgroundColor: "var(--bg-surface)",
              border: "1px solid var(--border-default)",
              color: "var(--accent-fg)",
              boxShadow: "var(--shadow)",
              cursor: "pointer",
              animation: "nqt-fadeIn 0.2s ease both",
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="12" y1="5" x2="12" y2="19" />
              <polyline points="19 12 12 19 5 12" />
            </svg>
          </button>
        )}

        {/* Input bar — one rounded composer holding the textarea and its action */}
        <div className="px-4 md:px-8 pt-2 pb-4">
          <form onSubmit={handleSend} className="td-composer flex gap-2 max-w-3xl mx-auto items-end">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={chatBlocked ? "El envío está pausado mientras restablecemos el servicio" : "Escribe tu pregunta sobre TotalDealer..."}
              disabled={sending || chatBlocked}
              rows={1}
              className="flex-1 px-3 py-2.5 focus:outline-none resize-none"
              style={{
                background: "transparent",
                border: "none",
                color: "var(--text-primary)",
                fontSize: 15,
                minWidth: 0,
                maxHeight: 120,
                lineHeight: 1.5,
              }}
              onInput={(e) => {
                const t = e.currentTarget;
                t.style.height = "auto";
                t.style.height = Math.min(t.scrollHeight, 120) + "px";
              }}
            />
            {sending ? (
              <button type="button" onClick={stopStreaming} className="nqt-btn nqt-btn--md nqt-btn--ghost shrink-0">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="3" /></svg>
                Detener
              </button>
            ) : (
              <button type="submit" disabled={!canSend} aria-label="Enviar" className="btn-send nqt-btn nqt-btn--md nqt-btn--primary shrink-0">
                <span className="hidden sm:inline">Enviar</span>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" />
                </svg>
              </button>
            )}
          </form>
          <p className="text-center mt-2" style={{ fontSize: 11, color: "var(--text-faint)" }}>
            {sending
              ? "Generando respuesta · Detener para cancelar"
              : chatBlocked
                ? "Envío en pausa · consulta el aviso de servicio"
                : "Enter para enviar · Shift+Enter para nueva línea"}
          </p>
        </div>
      </div>
    </div>
  );
}
