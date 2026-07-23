"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/AuthProvider";
import { ThemeToggle } from "@/components/ThemeToggle";
import { useToast } from "@/components/Toast";
import { getEscalations, updateEscalation, type Escalation, type EscalationStatus } from "@/lib/api";

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
  new: "var(--nqt-blue, #0ea5e9)",
  in_progress: "#f59e0b",
  resolved: "#22c55e",
};

function fmt(iso: string) {
  return new Date(iso).toLocaleDateString("es-MX", {
    day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
  });
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
        <span className="gv-label">Cargando...</span>
      </div>
    );
  }

  return (
    <div className="min-h-screen" style={{ backgroundColor: "var(--bg-page)" }}>
      {/* Header */}
      <div className="px-8 py-5" style={{ background: "linear-gradient(135deg, #050f1a 0%, #0a2540 100%)", borderBottom: "1px solid #1e3a5f" }}>
        <div className="max-w-5xl mx-auto flex items-start justify-between">
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
              <div style={{ width: 3, height: 18, backgroundColor: "var(--nqt-blue, #0ea5e9)", borderRadius: 2 }} />
              <h1 style={{ fontFamily: "var(--font-condensed)", fontWeight: 700, fontSize: 22, color: "#ffffff", letterSpacing: "0.5px" }}>
                Escalaciones
              </h1>
              {newCount > 0 && (
                <span style={{ fontFamily: "var(--font-condensed)", fontWeight: 700, fontSize: 11, color: "#fff", backgroundColor: "#ef4444", borderRadius: 999, padding: "1px 8px" }}>
                  {newCount}
                </span>
              )}
            </div>
            <p style={{ fontSize: 12, color: "#64748b", marginTop: 2, fontWeight: 300, paddingLeft: 11 }}>
              Usuarios que pidieron hablar con una persona del equipo.
            </p>
          </div>
          <div className="flex items-center gap-3 mt-1">
            <ThemeToggle className="p-1 transition-colors" style={{ color: "#64748b", background: "none", border: "none", cursor: "pointer" } as React.CSSProperties} />
            <button onClick={() => router.push("/admin")}
              style={{ fontSize: 10, color: "#64748b", fontFamily: "var(--font-condensed)", fontWeight: 600, letterSpacing: "2px", textTransform: "uppercase", background: "none", border: "none", cursor: "pointer" }}
              onMouseEnter={(e) => (e.currentTarget.style.color = "#e2e8f0")}
              onMouseLeave={(e) => (e.currentTarget.style.color = "#64748b")}>
              ← Admin
            </button>
          </div>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-4 md:px-8 py-6">
        {/* Filters */}
        <div className="flex gap-1 mb-5">
          {FILTERS.map((f) => (
            <button key={f.key} onClick={() => setFilter(f.key)}
              style={{
                fontFamily: "var(--font-condensed)", fontSize: 10, fontWeight: 700, letterSpacing: "1.5px",
                textTransform: "uppercase", padding: "6px 14px", cursor: "pointer", borderRadius: "var(--radius-sm)",
                border: "1px solid var(--border-default)",
                backgroundColor: filter === f.key ? "var(--btn-primary-bg)" : "transparent",
                color: filter === f.key ? "var(--btn-primary-text)" : "var(--text-muted)",
              }}>
              {f.label}
            </button>
          ))}
        </div>

        <div style={{ backgroundColor: "var(--bg-surface)", border: "1px solid var(--border-default)", borderRadius: "var(--radius)", overflow: "hidden" }}>
          {fetching && <p style={{ padding: 20, fontSize: 12, color: "var(--text-muted)", fontWeight: 300 }}>Cargando...</p>}
          {!fetching && list.length === 0 && (
            <p style={{ padding: "40px 20px", fontSize: 12, color: "var(--text-muted)", fontWeight: 300, textAlign: "center" }}>
              No hay solicitudes en esta vista.
            </p>
          )}
          {!fetching && list.map((e, i) => (
            <div key={e.id} className="px-5 py-4"
              style={{ borderTop: i === 0 ? "none" : "1px solid var(--border-default)" }}>
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                  <div className="flex items-center gap-2" style={{ marginBottom: 4 }}>
                    <span style={{
                      fontFamily: "var(--font-condensed)", fontSize: 9, fontWeight: 700, letterSpacing: "1px",
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
                    <p style={{ fontSize: 13, color: "var(--text-secondary)", fontWeight: 300, lineHeight: 1.5, marginTop: 3, whiteSpace: "pre-wrap" }}>
                      {e.reason}
                    </p>
                  )}
                  <p style={{ fontSize: 10, color: "var(--text-faint)", fontFamily: "var(--font-condensed)", letterSpacing: "0.5px", marginTop: 4 }}>
                    {fmt(e.created_at)}
                    {e.session_id && (
                      <>
                        {" · "}
                        <button onClick={() => router.push(`/admin/conversations?id=${e.session_id}`)}
                          style={{ color: "var(--nqt-blue, #0ea5e9)", background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", fontSize: 10, letterSpacing: "0.5px", textDecoration: "underline", padding: 0 }}>
                          Ver conversación
                        </button>
                      </>
                    )}
                  </p>
                </div>
                <div className="flex items-center gap-2" style={{ flexShrink: 0 }}>
                  {e.status !== "in_progress" && (
                    <button onClick={() => setStatus(e.id, "in_progress")}
                      style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: "var(--font-condensed)", fontWeight: 600, letterSpacing: "1px", textTransform: "uppercase", background: "none", border: "1px solid var(--border-default)", borderRadius: "var(--radius-sm)", padding: "5px 10px", cursor: "pointer" }}
                      onMouseEnter={(e2) => (e2.currentTarget.style.borderColor = "#f59e0b")}
                      onMouseLeave={(e2) => (e2.currentTarget.style.borderColor = "var(--border-default)")}>
                      En proceso
                    </button>
                  )}
                  {e.status !== "resolved" && (
                    <button onClick={() => setStatus(e.id, "resolved")}
                      style={{ fontSize: 10, color: "#22c55e", fontFamily: "var(--font-condensed)", fontWeight: 600, letterSpacing: "1px", textTransform: "uppercase", background: "none", border: "1px solid #22c55e", borderRadius: "var(--radius-sm)", padding: "5px 10px", cursor: "pointer" }}>
                      Resolver
                    </button>
                  )}
                  {e.status === "resolved" && (
                    <button onClick={() => setStatus(e.id, "new")}
                      style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: "var(--font-condensed)", fontWeight: 600, letterSpacing: "1px", textTransform: "uppercase", background: "none", border: "1px solid var(--border-default)", borderRadius: "var(--radius-sm)", padding: "5px 10px", cursor: "pointer" }}>
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
