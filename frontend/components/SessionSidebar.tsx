"use client";
import { useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { renameSession, deleteSession } from "@/lib/api";
import { ThemeToggle } from "@/components/ThemeToggle";
import { IconButton } from "@/components/ui";

export interface Session {
  id: string;
  title: string | null;
  created_at: string;
}

export const fmtSessionDate = (iso: string) =>
  new Date(iso).toLocaleDateString("es-MX", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

// Bucket a session by recency for the grouped sidebar list.
const sessionBucket = (iso: string): string => {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const t = new Date(iso).getTime();
  const day = 86400000;
  if (t >= startOfToday.getTime()) return "Hoy";
  if (t >= startOfToday.getTime() - day) return "Ayer";
  if (t >= startOfToday.getTime() - 7 * day) return "Últimos 7 días";
  return "Anteriores";
};
const BUCKET_ORDER = ["Hoy", "Ayer", "Últimos 7 días", "Anteriores"];

interface Props {
  user: { email?: string; is_admin?: boolean } | null;
  sessions: Session[];
  setSessions: React.Dispatch<React.SetStateAction<Session[]>>;
  currentSessionId: string | null;
  onOpenSession: (id: string) => void;
  onNewChat: () => void;
  onLogout: () => void;
  onToggleCollapsed: () => void;
  /** Called after a session is deleted so the parent can reset the open chat. */
  onDeleted: (id: string) => void;
}

export function SessionSidebar({
  user,
  sessions,
  setSessions,
  currentSessionId,
  onOpenSession,
  onNewChat,
  onLogout,
  onToggleCollapsed,
  onDeleted,
}: Props) {
  const router = useRouter();
  const [sessionQuery, setSessionQuery] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const fmt = fmtSessionDate;

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
      setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, title } : s)));
    } catch {}
  };

  const confirmDelete = async (id: string) => {
    setDeletingId(null);
    try {
      await deleteSession(id);
      setSessions((prev) => prev.filter((s) => s.id !== id));
      onDeleted(id);
    } catch {}
  };

  const q = sessionQuery.trim().toLowerCase();
  const filteredSessions = q
    ? sessions.filter(
        (s) => (s.title ?? "").toLowerCase().includes(q) || fmt(s.created_at).toLowerCase().includes(q),
      )
    : sessions;
  const groupedSessions = BUCKET_ORDER.map((label) => ({
    label,
    items: filteredSessions.filter((s) => sessionBucket(s.created_at) === label),
  })).filter((g) => g.items.length > 0);

  return (
    <aside
      className="flex flex-col h-full"
      style={{ backgroundColor: "var(--bg-sidebar)", width: 256, flexShrink: 0 }}
    >
      {/* Brand header */}
      <div className="px-5 py-5 relative" style={{ borderBottom: "1px solid #1e3a5f" }}>
        <Image
          src="/brand/nqt-logo-white.png"
          alt="Nexus Q Tech"
          width={160}
          height={58}
          priority
          unoptimized
          style={{ display: "block", width: 160, height: "auto" }}
        />
        <div style={{ fontFamily: "var(--font-condensed)", fontWeight: 500, fontSize: 9, color: "#0ea5e9", textTransform: "uppercase", letterSpacing: "2.5px", marginTop: 8 }}>
          Soporte · TotalDealer
        </div>
        {/* Collapse (desktop only — mobile closes via the overlay backdrop) */}
        <IconButton
          label="Ocultar barra lateral"
          onClick={onToggleCollapsed}
          className="hidden md:inline-flex"
          style={{ position: "absolute", top: 12, right: 12, color: "#7e9cc2" }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </IconButton>
      </div>

      {/* New chat */}
      <div className="px-4 py-3" style={{ borderBottom: "1px solid #1e3a5f" }}>
        <button
          onClick={onNewChat}
          className="w-full py-2.5 px-3 text-center transition-colors"
          style={{
            fontFamily: "var(--font-condensed)",
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

      {/* Session filter — only when there's enough history to be worth searching */}
      {sessions.length > 4 && (
        <div className="px-4 py-2.5" style={{ borderBottom: "1px solid #1e3a5f" }}>
          <input
            value={sessionQuery}
            onChange={(e) => setSessionQuery(e.target.value)}
            placeholder="Buscar conversación..."
            aria-label="Buscar conversación"
            className="w-full focus:outline-none"
            style={{
              fontFamily: "var(--font-body)",
              fontSize: 12,
              fontWeight: 300,
              background: "#0d2137",
              color: "#e2e8f0",
              border: "1px solid #1e3a5f",
              borderRadius: "var(--radius-sm)",
              padding: "6px 10px",
            }}
            onFocus={(e) => (e.currentTarget.style.borderColor = "#0ea5e9")}
            onBlur={(e) => (e.currentTarget.style.borderColor = "#1e3a5f")}
          />
        </div>
      )}

      {/* Session list */}
      <nav className="flex-1 overflow-y-auto py-2">
        {sessions.length === 0 && (
          <p style={{ padding: "12px 16px", fontSize: 10, color: "#7e9cc2", fontFamily: "var(--font-condensed)", letterSpacing: 1, textTransform: "uppercase" }}>
            Sin conversaciones
          </p>
        )}
        {sessions.length > 0 && groupedSessions.length === 0 && (
          <p style={{ padding: "12px 16px", fontSize: 10, color: "#7e9cc2", fontFamily: "var(--font-condensed)", letterSpacing: 1, textTransform: "uppercase" }}>
            Sin resultados
          </p>
        )}
        {groupedSessions.map((group) => (
          <div key={group.label}>
            <p style={{ padding: "10px 16px 4px", fontSize: 9, color: "#7e9cc2", fontFamily: "var(--font-condensed)", fontWeight: 700, letterSpacing: "1.5px", textTransform: "uppercase" }}>
              {group.label}
            </p>
            {group.items.map((s) => (
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
                      fontFamily: "var(--font-condensed)",
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
                    <p style={{ fontFamily: "var(--font-condensed)", fontSize: 10, letterSpacing: 1, textTransform: "uppercase", color: "#fca5a5", marginBottom: 6 }}>
                      ¿Eliminar conversación?
                    </p>
                    <div className="flex gap-2">
                      <button
                        onClick={() => confirmDelete(s.id)}
                        style={{ fontFamily: "var(--font-condensed)", fontSize: 10, letterSpacing: 1, textTransform: "uppercase", background: "#ef4444", color: "#fff", border: "none", cursor: "pointer", padding: "3px 8px", borderRadius: "var(--radius-sm)" }}
                      >
                        Eliminar
                      </button>
                      <button
                        onClick={() => setDeletingId(null)}
                        style={{ fontFamily: "var(--font-condensed)", fontSize: 10, letterSpacing: 1, textTransform: "uppercase", background: "transparent", color: "#64748b", border: "1px solid #1e3a5f", cursor: "pointer", padding: "3px 8px", borderRadius: "var(--radius-sm)" }}
                      >
                        Cancelar
                      </button>
                    </div>
                  </div>
                ) : (
                  /* Normal row */
                  <button
                    onClick={() => onOpenSession(s.id)}
                    className="w-full text-left px-4 py-2.5 pr-16"
                    style={{ background: "none", border: "none", cursor: "pointer" }}
                  >
                    <span style={{ fontFamily: "var(--font-condensed)", fontSize: 12, color: currentSessionId === s.id ? "#ffffff" : "#94a3b8", display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {s.title ?? fmt(s.created_at)}
                    </span>
                    <span style={{ fontFamily: "var(--font-condensed)", fontSize: 10, letterSpacing: "0.5px", textTransform: "uppercase", color: "#7e9cc2", display: "block" }}>
                      {fmt(s.created_at)}
                    </span>
                  </button>
                )}

                {/* Action icons — visible on hover when not editing/deleting */}
                {editingId !== s.id && deletingId !== s.id && (
                  <div className="absolute right-2 top-1/2 -translate-y-1/2 hidden group-hover:flex gap-1">
                    <IconButton
                      label="Renombrar conversación"
                      onClick={(e) => { e.stopPropagation(); startEdit(s); }}
                      style={{ color: "#7e9cc2" }}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                      </svg>
                    </IconButton>
                    <IconButton
                      label="Eliminar conversación"
                      tone="danger"
                      onClick={(e) => { e.stopPropagation(); setDeletingId(s.id); setEditingId(null); }}
                      style={{ color: "#7e9cc2" }}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
                        <path d="M10 11v6"/><path d="M14 11v6"/>
                        <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
                      </svg>
                    </IconButton>
                  </div>
                )}
              </div>
            ))}
          </div>
        ))}
      </nav>

      {/* Footer */}
      <div className="px-4 py-4 space-y-2" style={{ borderTop: "1px solid #1e3a5f" }}>
        {user && (
          <p style={{ fontSize: 10, color: "#7e9cc2", fontFamily: "var(--font-condensed)", letterSpacing: 1, textTransform: "uppercase", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {user.email}
          </p>
        )}
        {user?.is_admin && (
          <button
            onClick={() => router.push("/admin")}
            className="w-full py-2 px-3 text-center transition-colors"
            style={{
              fontFamily: "var(--font-condensed)",
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
            onClick={onLogout}
            style={{ fontSize: 10, color: "#7e9cc2", fontFamily: "var(--font-condensed)", letterSpacing: 1, textTransform: "uppercase", background: "none", border: "none", cursor: "pointer" }}
            onMouseEnter={(e) => (e.currentTarget.style.color = "#64748b")}
            onMouseLeave={(e) => (e.currentTarget.style.color = "#7e9cc2")}
          >
            Cerrar sesión
          </button>
          <ThemeToggle
            className="transition-colors p-1"
            style={{ color: "#7e9cc2", background: "none", border: "none", cursor: "pointer", lineHeight: 1 } as React.CSSProperties}
          />
        </div>
      </div>
    </aside>
  );
}
