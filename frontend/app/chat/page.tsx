"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/AuthProvider";
import { IS_LOCAL, localLogout } from "@/lib/auth";
import { sendMessage, getSessions, getSessionMessages } from "@/lib/api";
import { MessageBubble, type Message } from "@/components/MessageBubble";

interface Session {
  id: string;
  created_at: string;
}

export default function ChatPage() {
  const { user, loading, refresh } = useAuth();
  const router = useRouter();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!loading && !user) router.push("/");
  }, [user, loading, router]);

  useEffect(() => {
    if (user) loadSessions();
  }, [user]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, sending]);

  const loadSessions = async () => {
    try { setSessions(await getSessions()); } catch {}
  };

  const openSession = async (id: string) => {
    setCurrentSessionId(id);
    try { setMessages(await getSessionMessages(id)); } catch {}
  };

  const newChat = () => { setCurrentSessionId(null); setMessages([]); };

  const handleLogout = async () => {
    if (IS_LOCAL) {
      localLogout();
      refresh();
    } else {
      const { signOut } = await import("firebase/auth");
      const { auth } = await import("@/lib/firebase");
      await signOut(auth);
    }
    router.push("/");
  };

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text || sending) return;
    setInput("");
    setSending(true);
    setMessages((p) => [...p, { role: "user", content: text }]);
    try {
      const res = await sendMessage(text, currentSessionId);
      setCurrentSessionId(res.session_id);
      setMessages((p) => [
        ...p,
        { role: "assistant", content: res.answer, sources: { pdfs: res.pdf_sources, videos: res.video_sources } },
      ]);
      loadSessions();
    } catch {
      setMessages((p) => [...p, { role: "assistant", content: "Ocurrió un error. Por favor intenta de nuevo." }]);
    } finally {
      setSending(false);
    }
  };

  const fmt = (iso: string) =>
    new Date(iso).toLocaleDateString("es-MX", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

  if (loading) return <div className="flex items-center justify-center h-screen bg-gray-100"><span className="text-gray-400">Cargando...</span></div>;

  return (
    <div className="flex h-screen bg-gray-100">
      {/* Sidebar */}
      <aside className="w-64 bg-gray-900 text-white flex flex-col shrink-0">
        <div className="px-4 py-5 border-b border-gray-700">
          <h1 className="font-bold text-base">Nexus Support</h1>
          <p className="text-xs text-gray-400 mt-0.5">TotalDealer Assistant</p>
        </div>
        <div className="p-3">
          <button onClick={newChat} className="w-full py-2 px-3 bg-blue-600 hover:bg-blue-700 rounded-lg text-sm font-medium">
            + Nueva conversación
          </button>
        </div>
        <nav className="flex-1 overflow-y-auto px-2 space-y-0.5">
          {sessions.map((s) => (
            <button
              key={s.id}
              onClick={() => openSession(s.id)}
              className={`w-full text-left px-3 py-2 rounded-lg text-xs truncate transition-colors ${
                currentSessionId === s.id ? "bg-gray-700 text-white" : "text-gray-400 hover:bg-gray-800 hover:text-white"
              }`}
            >
              {fmt(s.created_at)}
            </button>
          ))}
        </nav>
        <div className="p-3 border-t border-gray-700 space-y-1">
          {user && <p className="text-xs text-gray-500 truncate px-1 mb-1">{user.email}</p>}
          <button onClick={() => router.push("/admin")} className="w-full py-2 px-3 bg-gray-700 hover:bg-gray-600 rounded-lg text-xs text-gray-200">
            Administrar documentos
          </button>
          <button onClick={handleLogout} className="w-full py-1.5 text-xs text-gray-500 hover:text-gray-300">
            Cerrar sesión
          </button>
        </div>
      </aside>

      {/* Chat */}
      <div className="flex-1 flex flex-col min-w-0">
        <div className="flex-1 overflow-y-auto px-6 py-6 space-y-4">
          {messages.length === 0 && (
            <div className="flex items-center justify-center h-full">
              <div className="text-center text-gray-400 max-w-sm">
                <p className="text-lg font-medium text-gray-600 mb-1">¿En qué puedo ayudarte?</p>
                <p className="text-sm">Pregunta sobre configuración, procesos o funciones de TotalDealer.</p>
              </div>
            </div>
          )}
          {messages.map((msg, i) => <MessageBubble key={i} message={msg} />)}
          {sending && (
            <div className="flex justify-start">
              <div className="bg-white rounded-2xl rounded-bl-sm px-4 py-3 shadow-sm border border-gray-100">
                <div className="flex space-x-1.5 items-center h-4">
                  {[0, 150, 300].map((d) => (
                    <span key={d} className="w-2 h-2 bg-gray-300 rounded-full animate-bounce" style={{ animationDelay: `${d}ms` }} />
                  ))}
                </div>
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>
        <div className="bg-white border-t px-4 py-4">
          <form onSubmit={handleSend} className="flex gap-3 max-w-3xl mx-auto">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Escribe tu pregunta sobre TotalDealer..."
              disabled={sending}
              className="flex-1 px-4 py-2.5 border border-gray-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-50"
            />
            <button type="submit" disabled={sending || !input.trim()} className="px-5 py-2.5 bg-blue-600 text-white rounded-xl text-sm font-medium hover:bg-blue-700 disabled:opacity-40">
              Enviar
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
