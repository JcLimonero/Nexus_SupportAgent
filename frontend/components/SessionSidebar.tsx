"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { renameSession, deleteSession } from "@/lib/api";
import { ThemeToggle } from "@/components/ThemeToggle";
import { BrandLogo } from "@/components/BrandLogo";
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

  const groupLabelStyle: React.CSSProperties = {
    padding: "14px 20px 6px", fontSize: 11, fontWeight: 600, letterSpacing: "0.06em",
    textTransform: "uppercase", color: "var(--text-faint)",
  };
  const emptyStyle: React.CSSProperties = { padding: "14px 20px", fontSize: 13, color: "var(--text-muted)" };

  return (
    <aside
      className="flex flex-col h-full"
      style={{ backgroundColor: "var(--bg-sidebar)", borderRight: "1px solid var(--border-default)", width: 272, flexShrink: 0 }}
    >
      {/* Brand header */}
      <div className="px-5 pt-5 pb-4 relative">
        <BrandLogo height={34} />
        {/* Collapse (desktop only — mobile closes via the overlay backdrop) */}
        <IconButton
          label="Ocultar barra lateral"
          onClick={onToggleCollapsed}
          className="hidden md:inline-flex"
          style={{ position: "absolute", top: 14, right: 12 }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </IconButton>
      </div>

      {/* New chat */}
      <div className="px-4 pb-3">
        <button
          onClick={onNewChat}
          className="nqt-btn nqt-btn--md nqt-btn--primary w-full"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
            <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          Nueva conversación
        </button>
      </div>

      {/* Session filter — only when there's enough history to be worth searching */}
      {sessions.length > 4 && (
        <div className="px-4 pb-2">
          <input
            value={sessionQuery}
            onChange={(e) => setSessionQuery(e.target.value)}
            placeholder="Buscar conversación..."
            aria-label="Buscar conversación"
            className="nqt-input w-full"
            style={{ fontSize: 13, padding: "8px 12px" }}
          />
        </div>
      )}

      {/* Session list */}
      <nav className="flex-1 overflow-y-auto pb-2" style={{ borderTop: "1px solid var(--border-default)" }}>
        {sessions.length === 0 && <p style={emptyStyle}>Sin conversaciones</p>}
        {sessions.length > 0 && groupedSessions.length === 0 && <p style={emptyStyle}>Sin resultados</p>}
        {groupedSessions.map((group) => (
          <div key={group.label}>
            <p style={groupLabelStyle}>{group.label}</p>
            {group.items.map((s) => {
              const active = currentSessionId === s.id;
              return (
                <div
                  key={s.id}
                  className="group relative"
                  style={{
                    margin: "1px 10px",
                    borderRadius: "var(--radius)",
                    backgroundColor: active ? "var(--bg-sidebar-active)" : "transparent",
                    boxShadow: active ? "inset 3px 0 0 var(--accent-bright)" : undefined,
                  }}
                  onMouseEnter={(e) => {
                    if (!active) e.currentTarget.style.backgroundColor = "var(--bg-sidebar-hover)";
                  }}
                  onMouseLeave={(e) => {
                    if (!active) e.currentTarget.style.backgroundColor = "transparent";
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
                      className="nqt-input w-full"
                      style={{ fontSize: 13, padding: "8px 10px" }}
                    />
                  ) : deletingId === s.id ? (
                    /* Delete confirmation */
                    <div className="px-3 py-2.5">
                      <p style={{ fontSize: 13, fontWeight: 600, color: "var(--danger-fg)", marginBottom: 8 }}>
                        ¿Eliminar conversación?
                      </p>
                      <div className="flex gap-2">
                        <button onClick={() => confirmDelete(s.id)} className="nqt-btn nqt-btn--sm nqt-btn--danger" style={{ padding: "4px 12px", fontSize: 12 }}>
                          Eliminar
                        </button>
                        <button onClick={() => setDeletingId(null)} className="nqt-btn nqt-btn--sm nqt-btn--ghost" style={{ padding: "4px 12px", fontSize: 12 }}>
                          Cancelar
                        </button>
                      </div>
                    </div>
                  ) : (
                    /* Normal row */
                    <button
                      onClick={() => onOpenSession(s.id)}
                      className="w-full text-left px-3 py-2 pr-16"
                      style={{ background: "none", border: "none", cursor: "pointer", borderRadius: "var(--radius)" }}
                    >
                      <span style={{ fontSize: 13, fontWeight: active ? 600 : 500, color: active ? "var(--text-primary)" : "var(--text-secondary)", display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {s.title ?? fmt(s.created_at)}
                      </span>
                      <span style={{ fontSize: 11, color: "var(--text-faint)", display: "block", marginTop: 1 }}>
                        {fmt(s.created_at)}
                      </span>
                    </button>
                  )}

                  {/* Action icons — visible on hover when not editing/deleting */}
                  {editingId !== s.id && deletingId !== s.id && (
                    <div className="absolute right-2 top-1/2 -translate-y-1/2 hidden group-hover:flex gap-0.5">
                      <IconButton
                        label="Renombrar conversación"
                        tone="accent"
                        onClick={(e) => { e.stopPropagation(); startEdit(s); }}
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                        </svg>
                      </IconButton>
                      <IconButton
                        label="Eliminar conversación"
                        tone="danger"
                        onClick={(e) => { e.stopPropagation(); setDeletingId(s.id); setEditingId(null); }}
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
                          <path d="M10 11v6"/><path d="M14 11v6"/>
                          <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
                        </svg>
                      </IconButton>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </nav>

      {/* Footer */}
      <div className="px-4 py-4 space-y-3" style={{ borderTop: "1px solid var(--border-default)" }}>
        {user && (
          <p style={{ fontSize: 12, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {user.email}
          </p>
        )}
        {user?.is_admin && (
          <button onClick={() => router.push("/admin")} className="nqt-btn nqt-btn--sm nqt-btn--ghost w-full">
            Administrar documentos
          </button>
        )}
        <div className="flex items-center justify-between">
          <button
            onClick={onLogout}
            style={{ fontSize: 13, fontWeight: 600, color: "var(--text-muted)", background: "none", border: "none", cursor: "pointer" }}
            onMouseEnter={(e) => (e.currentTarget.style.color = "var(--accent-fg)")}
            onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-muted)")}
          >
            Cerrar sesión
          </button>
          <ThemeToggle className="nqt-iconbtn" />
        </div>
      </div>
    </aside>
  );
}
