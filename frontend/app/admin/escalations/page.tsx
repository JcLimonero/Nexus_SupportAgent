"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/AuthProvider";
import { AdminHeader } from "@/components/AdminHeader";
import { useToast } from "@/components/Toast";
import { getEscalations, updateEscalation, getSignedMediaUrl, type Escalation, type EscalationStatus, type EscalationAttachment } from "@/lib/api";

type Filter = "new" | "in_progress" | "resolved" | "all";

const FILTERS: { key: Filter; label: string }[] = [
  { key: "new", label: "Nuevas" },
  { key: "in_progress", label: "En proceso" },
  { key: "resolved", label: "Resueltas" },
  { key: "all", label: "Todas" },
];

const STATUS_LABEL: Record<EscalationStatus, string> = {
  new: "Nueva",
  in_progress: "En proceso",
  resolved: "Resuelta",
};

const STATUS_COLOR: Record<EscalationStatus, string> = {
  new: "var(--accent-fg)",
  in_progress: "var(--status-warning-accent)",
  resolved: "var(--success)",
};

function fmt(iso: string) {
  return new Date(iso).toLocaleDateString("es-MX", {
    day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
  });
}

// Resolves the HMAC-signed stream URL for each attachment, then renders image
// thumbnails inline and a download link for everything else.
function Attachments({ items }: { items: EscalationAttachment[] }) {
  const [urls, setUrls] = useState<Record<string, string>>({});

  useEffect(() => {
    let alive = true;
    (async () => {
      const resolved: Record<string, string> = {};
      await Promise.all(items.map(async (a) => {
        try { resolved[a.url] = await getSignedMediaUrl(a.url); } catch { /* skip */ }
      }));
      if (alive) setUrls(resolved);
    })();
    return () => { alive = false; };
  }, [items]);

  return (
    <div className="flex flex-wrap gap-2" style={{ marginTop: 8 }}>
      {items.map((a) => {
        const src = urls[a.url];
        const isImage = (a.content_type ?? "").startsWith("image/");
        if (isImage && src) {
          return (
            <a key={a.url} href={src} target="_blank" rel="noopener noreferrer" title={a.file_name}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={src} alt={a.file_name}
                style={{ height: 72, width: 72, objectFit: "cover", borderRadius: "var(--radius-sm)", border: "1px solid var(--border-default)" }} />
            </a>
          );
        }
        return (
          <a key={a.url} href={src ?? "#"} target="_blank" rel="noopener noreferrer" title={a.file_name}
            style={{
              display: "flex", alignItems: "center", gap: 6, fontSize: 11,
              color: src ? "var(--accent-fg)" : "var(--text-muted)",
              backgroundColor: "var(--bg-muted)", border: "1px solid var(--border-default)",
              borderRadius: "var(--radius-sm)", padding: "6px 10px", maxWidth: 220,
              pointerEvents: src ? "auto" : "none",
            }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" />
            </svg>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.file_name}</span>
          </a>
        );
      })}
    </div>
  );
}

export default function EscalationsPage() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const { toast } = useToast();

  const [filter, setFilter] = useState<Filter>("new");
  const [list, setList] = useState<Escalation[]>([]);
  const [newCount, setNewCount] = useState(0);
  const [fetching, setFetching] = useState(true);

  useEffect(() => {
    if (!loading && (!user || !user.is_admin)) router.push("/chat");
  }, [user, loading, router]);

  const load = useCallback(async () => {
    setFetching(true);
    try {
      const { new_count, items } = await getEscalations(filter === "all" ? undefined : filter);
      setNewCount(new_count);
      setList(items);
    } catch {
      toast("Error al cargar las escalaciones.", "error");
    } finally {
      setFetching(false);
    }
  }, [filter, toast]);

  useEffect(() => { if (user?.is_admin) load(); }, [user, load]);

  const setStatus = async (id: string, status: EscalationStatus) => {
    try {
      await updateEscalation(id, status);
      // Optimistic update for snappiness; load() reconciles list + new_count.
      if (filter !== "all" && filter !== status) {
        setList((prev) => prev.filter((e) => e.id !== id));
      } else {
        setList((prev) => prev.map((e) => (e.id === id ? { ...e, status } : e)));
      }
      load();
    } catch {
      toast("No se pudo actualizar el estado.", "error");
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen" style={{ backgroundColor: "var(--bg-page)" }}>
        <span className="nqt-label">Cargando...</span>
      </div>
    );
  }

  return (
    <div className="min-h-screen" style={{ backgroundColor: "var(--bg-page)" }}>
      {/* Pass the triage count so the tab badge drops as requests are handled. */}
      <AdminHeader
        title="Escalaciones"
        subtitle="Usuarios que solicitaron ayuda del equipo de soporte."
        counts={{ escalations: fetching ? null : newCount }}
      />

      <div className="max-w-5xl mx-auto px-4 md:px-8 py-6">
        {/* Filters */}
        <div className="flex gap-1 mb-5">
          {FILTERS.map((f) => (
            <button key={f.key} onClick={() => setFilter(f.key)}
              style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.06em",
                textTransform: "uppercase", padding: "6px 14px", cursor: "pointer", borderRadius: "var(--radius-sm)",
                border: "1px solid var(--border-default)",
                backgroundColor: filter === f.key ? "var(--btn-primary-bg)" : "transparent",
                color: filter === f.key ? "var(--btn-primary-text)" : "var(--text-muted)",
              }}>
              {f.label}
            </button>
          ))}
        </div>

        <div style={{ backgroundColor: "var(--bg-surface)", border: "1px solid var(--border-default)", borderRadius: "var(--radius-lg)", boxShadow: "var(--shadow)", overflow: "hidden" }}>
          {fetching && <p style={{ padding: 20, fontSize: 12, color: "var(--text-muted)", fontWeight: 400 }}>Cargando...</p>}
          {!fetching && list.length === 0 && (
            <p style={{ padding: "40px 20px", fontSize: 12, color: "var(--text-muted)", fontWeight: 400, textAlign: "center" }}>
              No hay solicitudes en esta vista.
            </p>
          )}
          {!fetching && list.map((e, i) => (
            <div key={e.id} className="px-5 py-4"
              style={{ borderTop: i === 0 ? "none" : "1px solid var(--border-default)" }}>
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                  <div className="flex items-center gap-2" style={{ marginBottom: 4 }}>
                    <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.06em",
                      textTransform: "uppercase", padding: "1px 7px", borderRadius: "var(--radius-sm)",
                      border: `1px solid ${STATUS_COLOR[e.status]}`, color: STATUS_COLOR[e.status],
                    }}>
                      {STATUS_LABEL[e.status]}
                    </span>
                    <span style={{ fontSize: 13, color: "var(--text-primary)", fontWeight: 500 }}>
                      {e.name || e.user_label || "—"}
                    </span>
                  </div>
                  <p style={{ fontSize: 13, color: "var(--text-primary)", fontWeight: 400 }}>
                    <span style={{ color: "var(--text-muted)" }}>Contacto: </span>{e.contact}
                  </p>
                  {e.reason && (
                    <p style={{ fontSize: 13, color: "var(--text-secondary)", fontWeight: 400, lineHeight: 1.5, marginTop: 3, whiteSpace: "pre-wrap" }}>
                      {e.reason}
                    </p>
                  )}
                  {e.attachments && e.attachments.length > 0 && <Attachments items={e.attachments} />}
                  <p style={{ fontSize: 10, color: "var(--text-faint)", marginTop: 4 }}>
                    {fmt(e.created_at)}
                    {e.session_id && (
                      <>
                        {" · "}
                        <button onClick={() => router.push(`/admin/conversations?id=${e.session_id}`)}
                          style={{ color: "var(--accent-fg)", background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", fontSize: 10, letterSpacing: "0.5px", textDecoration: "underline", padding: 0 }}>
                          Ver conversación
                        </button>
                      </>
                    )}
                  </p>
                </div>
                <div className="flex items-center gap-2" style={{ flexShrink: 0 }}>
                  {e.status !== "in_progress" && (
                    <button onClick={() => setStatus(e.id, "in_progress")}
                      style={{ fontSize: 10, color: "var(--text-muted)", fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", background: "none", border: "1px solid var(--border-default)", borderRadius: "var(--radius-sm)", padding: "5px 10px", cursor: "pointer" }}
                      onMouseEnter={(e2) => (e2.currentTarget.style.borderColor = "var(--status-warning-accent)")}
                      onMouseLeave={(e2) => (e2.currentTarget.style.borderColor = "var(--border-default)")}>
                      En proceso
                    </button>
                  )}
                  {e.status !== "resolved" && (
                    <button onClick={() => setStatus(e.id, "resolved")}
                      style={{ fontSize: 10, color: "var(--success)", fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", background: "none", border: "1px solid var(--success)", borderRadius: "var(--radius-sm)", padding: "5px 10px", cursor: "pointer" }}>
                      Resolver
                    </button>
                  )}
                  {e.status === "resolved" && (
                    <button onClick={() => setStatus(e.id, "new")}
                      style={{ fontSize: 10, color: "var(--text-muted)", fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", background: "none", border: "1px solid var(--border-default)", borderRadius: "var(--radius-sm)", padding: "5px 10px", cursor: "pointer" }}>
                      Reabrir
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
