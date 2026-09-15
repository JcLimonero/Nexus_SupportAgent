"use client";
import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/AuthProvider";
import Link from "next/link";
import { uploadFile, getDocuments, deleteDocument } from "@/lib/api";
import { AdminHeader, AdminIcon, useAdminCounts, type AdminIconName } from "@/components/AdminHeader";
import { useToast } from "@/components/Toast";
import { getBearerToken } from "@/lib/auth";

const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

interface Doc {
  file_name: string;
  source_type: string;
  gcs_url: string;
}

// Video sources show in cyan; every document type (pdf, docx, pptx, txt, md, csv)
// shows in blue with its own short label.
function sourceBadge(sourceType: string): { label: string; accent: "video" | "doc" } {
  if (sourceType === "video") return { label: "VID", accent: "video" };
  return { label: sourceType.toUpperCase(), accent: "doc" };
}

interface Stats {
  users:     { total: number; active: number };
  sessions:  { total: number };
  messages:  { total: number };
  documents: { total: number };
  cache:     { entries: number; total_hits: number };
  feedback:  { up: number; down: number };
}

function StatCard({ label, value, sub }: { label: string; value: number | string; sub?: string }) {
  return (
    <div style={{
      backgroundColor: "var(--bg-surface)",
      border: "1px solid var(--border-default)",
      borderLeft: "3px solid var(--nqt-blue, #0ea5e9)",
      borderRadius: "var(--radius)",
      padding: "16px 20px",
    }}>
      <p style={{ fontFamily: "var(--font-condensed)", fontSize: 9, fontWeight: 600, letterSpacing: "2px", textTransform: "uppercase", color: "var(--text-muted)", marginBottom: 6 }}>{label}</p>
      <p style={{ fontFamily: "var(--font-condensed)", fontSize: 28, fontWeight: 700, color: "var(--nqt-blue, #0ea5e9)", lineHeight: 1 }}>{value}</p>
      {sub && <p style={{ fontSize: 11, color: "var(--text-faint)", marginTop: 4, fontWeight: 300 }}>{sub}</p>}
    </div>
  );
}

// Card accent follows what's waiting: red for untriaged requests, amber for live
// notices, brand blue otherwise. Text uses the theme-aware status tokens.
const QUICK_TONE = {
  neutral:  { accent: "var(--nqt-blue, #0ea5e9)", text: "var(--text-muted)" },
  critical: { accent: "#ef4444", text: "var(--status-critical)" },
  warning:  { accent: "#f59e0b", text: "var(--status-warning)" },
};

function QuickLink({ href, icon, title, value, detail, tone = "neutral" }: {
  href: string;
  icon: AdminIconName;
  title: string;
  value: number | string;
  detail: string;
  tone?: keyof typeof QUICK_TONE;
}) {
  const t = QUICK_TONE[tone];
  return (
    <Link href={href} className="admin-quick-card" style={{ "--card-accent": t.accent } as React.CSSProperties}>
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 min-w-0" style={{ color: t.accent }}>
          <AdminIcon name={icon} />
          <span style={{ fontFamily: "var(--font-condensed)", fontSize: 11, fontWeight: 700, letterSpacing: "1.5px", textTransform: "uppercase", color: "var(--text-secondary)" }}>
            {title}
          </span>
        </span>
        <span aria-hidden="true" style={{ color: "var(--text-faint)" }}>→</span>
      </div>
      <p style={{ fontFamily: "var(--font-condensed)", fontSize: 26, fontWeight: 700, color: "var(--text-primary)", lineHeight: 1, marginTop: 10 }}>{value}</p>
      <p style={{ fontSize: 11, color: t.text, marginTop: 4 }}>{detail}</p>
    </Link>
  );
}

export default function AdminPage() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const { toast } = useToast();
  const [docs, setDocs]             = useState<Doc[]>([]);
  const [uploading, setUploading]   = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{ current: number; total: number } | null>(null);
  const [dragOver, setDragOver]     = useState(false);
  const [stats, setStats]           = useState<Stats | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [deleting, setDeleting]     = useState(false);
  // Shared with the header so its tab badges don't fetch the same numbers again.
  const counts = useAdminCounts(!!user?.is_admin);

  useEffect(() => {
    if (!loading && (!user || !user.is_admin)) router.push("/");
    if (user?.is_admin) { loadDocs(); loadStats(); }
  }, [user, loading]);

  const loadDocs = async () => {
    try { setDocs(await getDocuments()); } catch {}
  };

  const loadStats = async () => {
    try {
      const token = await getBearerToken();
      const res = await fetch(`${API}/api/admin/stats`, { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) setStats(await res.json());
    } catch {}
  };

  const handleFiles = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const list = Array.from(files);
    setUploading(true);
    // Upload sequentially so we pace requests under the rate limit and can show
    // per-file progress; uploadFile auto-retries on 429 for large batches.
    let ok = 0, failed = 0;
    for (let i = 0; i < list.length; i++) {
      setUploadProgress({ current: i + 1, total: list.length });
      try {
        await uploadFile(list[i]);
        ok++;
      } catch {
        failed++;
      }
    }
    setUploadProgress(null);
    if (failed === 0) {
      toast(`${ok} archivo(s) subido(s). La indexación puede tardar unos minutos.`, "success");
    } else {
      toast(`${ok} subido(s), ${failed} con error. Verifica el formato y el tamaño.`, failed === list.length ? "error" : "success");
    }
    setTimeout(() => { loadDocs(); loadStats(); }, 5000);
    setUploading(false);
  }, [toast]);

  const handleDelete = (fileName: string) => {
    setPendingDelete(fileName);
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    const fileName = pendingDelete;
    setPendingDelete(null);
    setDeleting(true);
    try {
      await deleteDocument(fileName);
      setDocs((prev) => prev.filter((d) => d.file_name !== fileName));
      toast(`"${fileName}" eliminado del índice.`, "success");
      loadStats();
    } catch {
      toast("Error al eliminar el documento.", "error");
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

  return (
    <div className="min-h-screen" style={{ backgroundColor: "var(--bg-page)" }}>
      <AdminHeader
        title="Panel de administración"
        subtitle="Documentos, estadísticas y gestión de usuarios."
        maxWidth="max-w-4xl"
        counts={counts ?? undefined}
      />

      <div className="max-w-4xl mx-auto px-4 md:px-8 py-8 space-y-8">

        {/* Quick access — each section with what's waiting in it */}
        <div>
          <p style={{ fontFamily: "var(--font-condensed)", fontSize: 10, fontWeight: 600, letterSpacing: "2px", textTransform: "uppercase", color: "var(--text-muted)", marginBottom: 12 }}>
            Accesos rápidos
          </p>
          <div data-testid="admin-quick-links" className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <QuickLink
              href="/admin/users" icon="users" title="Usuarios"
              value={stats?.users.total ?? "—"}
              detail={stats ? `${stats.users.active} activos` : "Cargando…"}
            />
            <QuickLink
              href="/admin/conversations" icon="conversations" title="Conversaciones"
              value={stats?.sessions.total ?? "—"}
              detail={stats ? `${stats.messages.total} mensajes` : "Cargando…"}
            />
            <QuickLink
              href="/admin/escalations" icon="escalations" title="Escalaciones"
              value={counts?.escalations ?? "—"}
              detail={!counts ? "Cargando…" : counts.escalations > 0 ? "Nuevas por atender" : "Sin pendientes"}
              tone={counts && counts.escalations > 0 ? "critical" : "neutral"}
            />
            <QuickLink
              href="/admin/avisos" icon="notices" title="Avisos"
              value={counts?.avisos ?? "—"}
              detail={!counts ? "Cargando…" : counts.avisos > 0 ? "Activos ahora" : "Sin avisos activos"}
              tone={counts && counts.avisos > 0 ? "warning" : "neutral"}
            />
          </div>
        </div>

        {/* Stats grid */}
        <div>
          <p style={{ fontFamily: "var(--font-condensed)", fontSize: 10, fontWeight: 600, letterSpacing: "2px", textTransform: "uppercase", color: "var(--text-muted)", marginBottom: 12 }}>
            Resumen del sistema
          </p>
          {stats ? (
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              {[
                <StatCard key="u" label="Usuarios"   value={stats.users.total}     sub={`${stats.users.active} activos`} />,
                <StatCard key="s" label="Sesiones"   value={stats.sessions.total} />,
                <StatCard key="m" label="Mensajes"   value={stats.messages.total} />,
                <StatCard key="d" label="Documentos" value={stats.documents.total} sub="archivos únicos indexados" />,
                <StatCard key="c" label="Caché"      value={stats.cache.entries}   sub={`${stats.cache.total_hits} hits totales`} />,
                <StatCard key="f" label="Feedback"
                  value={`${stats.feedback.up}↑ ${stats.feedback.down}↓`}
                  sub={stats.feedback.up + stats.feedback.down > 0
                    ? `${Math.round((stats.feedback.up / (stats.feedback.up + stats.feedback.down)) * 100)}% positivo`
                    : "sin valoraciones aún"}
                />,
              ].map((card, i) => (
                <div key={i} style={{ animation: "nqt-slideUp 0.3s ease both", animationDelay: `${i * 50}ms` }}>
                  {card}
                </div>
              ))}
            </div>
          ) : (
            /* Skeleton shimmer while stats load */
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <div
                  key={i}
                  style={{
                    border: "1px solid var(--border-default)",
                    borderLeft: "3px solid var(--border-default)",
                    borderRadius: "var(--radius)",
                    padding: "16px 20px",
                  }}
                >
                  <div className="nqt-skeleton" style={{ height: 10, width: "55%", marginBottom: 12 }} />
                  <div className="nqt-skeleton" style={{ height: 22, width: "40%" }} />
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Upload zone */}
        <div>
          <p style={{ fontFamily: "var(--font-condensed)", fontSize: 10, fontWeight: 600, letterSpacing: "2px", textTransform: "uppercase", color: "var(--text-muted)", marginBottom: 12 }}>
            Subir documentos
          </p>
          <div
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => { e.preventDefault(); setDragOver(false); handleFiles(e.dataTransfer.files); }}
            style={{
              border: `2px dashed ${dragOver ? "var(--nqt-blue, #0ea5e9)" : "var(--border-strong)"}`,
              backgroundColor: dragOver ? "rgba(14,165,233,0.05)" : "var(--bg-surface)",
              borderRadius: "var(--radius)",
              padding: "40px 24px",
              textAlign: "center",
              transition: "border-color 0.15s, background-color 0.15s",
            }}
          >
            <input id="file-input" type="file" accept=".pdf,.mp4,.mp3,.m4a,.wav,.ogg,.docx,.pptx,.txt,.md,.csv" multiple className="hidden" onChange={(e) => handleFiles(e.target.files)} />
            <label htmlFor="file-input" className="cursor-pointer block">
              <div style={{ fontSize: 28, marginBottom: 12, color: dragOver ? "var(--nqt-blue, #0ea5e9)" : "var(--text-faint)" }}>
                {uploading ? "⏳" : "↑"}
              </div>
              <p style={{ fontFamily: "var(--font-condensed)", fontWeight: 600, fontSize: 13, textTransform: "uppercase", letterSpacing: "1px", color: "var(--text-primary)" }}>
                {uploading
                  ? uploadProgress
                    ? `Subiendo ${uploadProgress.current} de ${uploadProgress.total}...`
                    : "Subiendo y lanzando indexación..."
                  : "Arrastra archivos · o haz clic para seleccionar"}
              </p>
              <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 6, fontFamily: "var(--font-condensed)", letterSpacing: 1 }}>
                PDF · MP4 · MP3 · M4A · WAV · OGG · DOCX · PPTX · TXT · MD · CSV · máx. 100 MB
              </p>
            </label>
          </div>
        </div>

        {/* Documents list */}
        <div style={{ backgroundColor: "var(--bg-surface)", border: "1px solid var(--border-default)", borderRadius: "var(--radius)", overflow: "hidden" }}>
          <div className="px-5 py-4 flex items-center justify-between" style={{ borderBottom: "1px solid var(--border-default)" }}>
            <div>
              <span className="gv-label">Documentos indexados</span>
              <span style={{ marginLeft: 8, fontSize: 10, color: "var(--text-faint)", fontFamily: "var(--font-condensed)" }}>({docs.length})</span>
            </div>
            <button
              onClick={() => { loadDocs(); loadStats(); }}
              style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: "var(--font-condensed)", fontWeight: 600, letterSpacing: "1.5px", textTransform: "uppercase", background: "none", border: "none", cursor: "pointer" }}
              onMouseEnter={(e) => (e.currentTarget.style.color = "var(--nqt-blue, #0ea5e9)")}
              onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-muted)")}
            >
              Actualizar
            </button>
          </div>

          {docs.length === 0 ? (
            <p className="py-12 text-center" style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 300 }}>
              No hay documentos indexados aún.
            </p>
          ) : (
            <ul>
              {docs.map((doc, i) => (
                <li
                  key={doc.file_name}
                  className="flex items-center justify-between px-5 py-3 transition-colors"
                  style={{
                    borderTop: i === 0 ? "none" : `1px solid var(--border-default)`,
                    borderLeft: "3px solid transparent",
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.borderLeftColor = "var(--nqt-blue, #0ea5e9)")}
                  onMouseLeave={(e) => (e.currentTarget.style.borderLeftColor = "transparent")}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    {(() => {
                      const badge = sourceBadge(doc.source_type);
                      const isDoc = badge.accent === "doc";
                      return (
                        <span
                          className="shrink-0"
                          style={{
                            fontFamily: "var(--font-condensed)",
                            fontSize: 9,
                            fontWeight: 700,
                            letterSpacing: "1.5px",
                            textTransform: "uppercase",
                            color: isDoc ? "var(--nqt-blue, #0ea5e9)" : "var(--nqt-cyan, #06b6d4)",
                            backgroundColor: isDoc ? "rgba(14,165,233,0.1)" : "rgba(6,182,212,0.1)",
                            border: `1px solid ${isDoc ? "rgba(14,165,233,0.3)" : "rgba(6,182,212,0.3)"}`,
                            borderRadius: "3px",
                            padding: "1px 5px",
                          }}
                        >
                          {badge.label}
                        </span>
                      );
                    })()}
                    <p className="text-sm font-light truncate" style={{ color: "var(--text-secondary)" }}>
                      {doc.file_name}
                    </p>
                  </div>
                  <button
                    onClick={() => handleDelete(doc.file_name)}
                    className="shrink-0 ml-4 transition-colors"
                    style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: "var(--font-condensed)", fontWeight: 600, letterSpacing: "1px", textTransform: "uppercase", background: "none", border: "none", cursor: "pointer" }}
                    onMouseEnter={(e) => (e.currentTarget.style.color = "#f87171")}
                    onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-muted)")}
                  >
                    Eliminar
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Delete confirmation modal */}
      {pendingDelete && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ backgroundColor: "rgba(5,15,26,0.7)", backdropFilter: "blur(2px)" }}
          onClick={() => setPendingDelete(null)}
        >
          <div
            className="w-full max-w-sm"
            style={{
              backgroundColor: "var(--bg-surface)",
              border: "1px solid var(--border-default)",
              borderTop: "3px solid #f87171",
              borderRadius: "var(--radius-lg)",
              boxShadow: "0 20px 40px rgba(0,0,0,0.4)",
              overflow: "hidden",
              animation: "nqt-modalIn 0.22s cubic-bezier(0.16, 1, 0.3, 1) both",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal header */}
            <div className="px-6 pt-6 pb-4">
              <p style={{ fontFamily: "var(--font-condensed)", fontWeight: 700, fontSize: 16, color: "var(--text-primary)", textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 8 }}>
                Eliminar documento
              </p>
              <p style={{ fontSize: 13, color: "var(--text-secondary)", fontWeight: 300, lineHeight: 1.6 }}>
                ¿Eliminar{" "}
                <span style={{ fontWeight: 600, color: "var(--text-primary)" }}>
                  &quot;{pendingDelete}&quot;
                </span>{" "}
                del índice de búsqueda? Esta acción no se puede deshacer.
              </p>
            </div>

            {/* Modal footer */}
            <div
              className="px-6 py-4 flex items-center justify-end gap-3"
              style={{ borderTop: "1px solid var(--border-default)", backgroundColor: "var(--bg-muted)" }}
            >
              <button
                onClick={() => setPendingDelete(null)}
                style={{
                  fontFamily: "var(--font-condensed)",
                  fontWeight: 600,
                  fontSize: 11,
                  letterSpacing: "1.5px",
                  textTransform: "uppercase",
                  background: "none",
                  border: "1px solid var(--border-strong)",
                  borderRadius: "var(--radius-sm)",
                  padding: "7px 16px",
                  color: "var(--text-muted)",
                  cursor: "pointer",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text-primary)")}
                onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-muted)")}
              >
                Cancelar
              </button>
              <button
                onClick={confirmDelete}
                disabled={deleting}
                style={{
                  fontFamily: "var(--font-condensed)",
                  fontWeight: 700,
                  fontSize: 11,
                  letterSpacing: "1.5px",
                  textTransform: "uppercase",
                  backgroundColor: "#ef4444",
                  color: "#ffffff",
                  border: "none",
                  borderRadius: "var(--radius-sm)",
                  padding: "7px 16px",
                  cursor: deleting ? "not-allowed" : "pointer",
                  opacity: deleting ? 0.6 : 1,
                }}
                onMouseEnter={(e) => { if (!deleting) e.currentTarget.style.backgroundColor = "#dc2626"; }}
                onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "#ef4444")}
              >
                {deleting ? "Eliminando..." : "Eliminar"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
