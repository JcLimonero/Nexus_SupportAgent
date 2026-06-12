"use client";
import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/AuthProvider";
import { uploadFile, getDocuments, deleteDocument } from "@/lib/api";
import { ThemeToggle } from "@/components/ThemeToggle";

interface Doc {
  file_name: string;
  source_type: "pdf" | "video";
  gcs_url: string;
}

export default function AdminPage() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const [docs, setDocs]           = useState<Doc[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver]   = useState(false);
  const [notice, setNotice]       = useState<{ text: string; ok: boolean } | null>(null);

  useEffect(() => {
    if (!loading && (!user || !user.is_admin)) router.push("/");
    if (user?.is_admin) loadDocs();
  }, [user, loading]);

  const loadDocs = async () => {
    try { setDocs(await getDocuments()); } catch {}
  };

  const showNotice = (text: string, ok: boolean) => {
    setNotice({ text, ok });
    setTimeout(() => setNotice(null), 4000);
  };

  const handleFiles = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      await Promise.all(Array.from(files).map((f) => uploadFile(f)));
      showNotice(`${files.length} archivo(s) subido(s). La indexación puede tardar unos minutos.`, true);
      setTimeout(loadDocs, 5000);
    } catch {
      showNotice("Error al subir los archivos. Verifica el formato e inténtalo de nuevo.", false);
    } finally {
      setUploading(false);
    }
  }, []);

  const handleDelete = async (fileName: string) => {
    if (!confirm(`¿Eliminar "${fileName}" del índice de búsqueda?`)) return;
    try {
      await deleteDocument(fileName);
      setDocs((prev) => prev.filter((d) => d.file_name !== fileName));
    } catch {
      showNotice("Error al eliminar el documento.", false);
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
      {/* Header — always dark */}
      <div className="px-8 py-5" style={{ backgroundColor: "var(--gv-black, #222222)", borderBottom: "1px solid #333" }}>
        <div className="max-w-2xl mx-auto flex items-start justify-between">
          <div>
            <div style={{ width: 28, height: 2, backgroundColor: "#98989A", marginBottom: 10 }} />
            <h1 style={{ fontFamily: '"Barlow Condensed", sans-serif', fontWeight: 700, fontSize: 22, color: "#ffffff", textTransform: "uppercase", letterSpacing: "0.5px" }}>
              Administrar documentos
            </h1>
            <p style={{ fontSize: 12, color: "#777", marginTop: 4, fontWeight: 300 }}>
              Sube PDFs y videos para que el agente los indexe.
            </p>
            {user?.is_admin && (
              <button
                onClick={() => router.push("/admin/users")}
                style={{ marginTop: 8, fontSize: 10, color: "#98989A", fontFamily: '"Barlow Condensed", sans-serif', fontWeight: 600, letterSpacing: "2px", textTransform: "uppercase", background: "none", border: "none", cursor: "pointer", textDecoration: "underline" }}
              >
                Gestionar usuarios →
              </button>
            )}
          </div>
          <div className="flex items-center gap-3 mt-1">
            <ThemeToggle
              className="transition-colors p-1"
              style={{ color: "#777", background: "none", border: "none", cursor: "pointer" } as React.CSSProperties}
            />
            <button
              onClick={() => router.push("/chat")}
              style={{ fontSize: 10, color: "#98989A", fontFamily: '"Barlow Condensed", sans-serif', fontWeight: 600, letterSpacing: "2px", textTransform: "uppercase", background: "none", border: "none", cursor: "pointer" }}
              onMouseEnter={(e) => (e.currentTarget.style.color = "#e8e8e8")}
              onMouseLeave={(e) => (e.currentTarget.style.color = "#98989A")}
            >
              ← Chat
            </button>
          </div>
        </div>
      </div>

      <div className="max-w-2xl mx-auto px-4 md:px-8 py-8 space-y-6">
        {/* Notice */}
        {notice && (
          <div
            className="px-4 py-3 text-sm font-light"
            style={{
              borderLeft: `3px solid ${notice.ok ? "#4a7c4a" : "#c0392b"}`,
              backgroundColor: notice.ok ? "rgba(74,124,74,0.08)" : "rgba(192,57,43,0.08)",
              color: notice.ok ? "#4a7c4a" : "#c0392b",
            }}
          >
            {notice.text}
          </div>
        )}

        {/* Upload zone */}
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); handleFiles(e.dataTransfer.files); }}
          style={{
            border: `2px dashed ${dragOver ? "var(--text-primary)" : "var(--border-strong)"}`,
            backgroundColor: dragOver ? "var(--bg-muted)" : "var(--bg-surface)",
            padding: "40px 24px",
            textAlign: "center",
            transition: "border-color 0.15s, background-color 0.15s",
          }}
        >
          <input
            id="file-input"
            type="file"
            accept=".pdf,.mp4"
            multiple
            className="hidden"
            onChange={(e) => handleFiles(e.target.files)}
          />
          <label htmlFor="file-input" className="cursor-pointer block">
            <div style={{ fontSize: 32, marginBottom: 12 }}>{uploading ? "⏳" : "↑"}</div>
            <p style={{ fontFamily: '"Barlow Condensed", sans-serif', fontWeight: 600, fontSize: 13, textTransform: "uppercase", letterSpacing: "1px", color: "var(--text-primary)" }}>
              {uploading ? "Subiendo y lanzando indexación..." : "Arrastra archivos · o haz clic para seleccionar"}
            </p>
            <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 6, fontFamily: '"Barlow Condensed", sans-serif', letterSpacing: 1 }}>
              PDF · MP4
            </p>
          </label>
        </div>

        {/* Documents list */}
        <div style={{ backgroundColor: "var(--bg-surface)", border: "1px solid var(--border-default)" }}>
          <div
            className="px-5 py-4 flex items-center justify-between"
            style={{ borderBottom: "1px solid var(--border-default)" }}
          >
            <div>
              <span className="gv-label">Documentos indexados</span>
              <span style={{ marginLeft: 8, fontSize: 10, color: "var(--text-faint)", fontFamily: '"Barlow Condensed", sans-serif' }}>
                ({docs.length})
              </span>
            </div>
            <button
              onClick={loadDocs}
              style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: '"Barlow Condensed", sans-serif', fontWeight: 600, letterSpacing: "1.5px", textTransform: "uppercase", background: "none", border: "none", cursor: "pointer" }}
              onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text-primary)")}
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
                  className="flex items-center justify-between px-5 py-3"
                  style={{
                    borderTop: i === 0 ? "none" : `1px solid var(--border-default)`,
                    borderLeft: "3px solid var(--border-strong)",
                  }}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="gv-label shrink-0">{doc.source_type === "pdf" ? "PDF" : "VID"}</span>
                    <p className="text-sm font-light truncate" style={{ color: "var(--text-secondary)" }}>
                      {doc.file_name}
                    </p>
                  </div>
                  <button
                    onClick={() => handleDelete(doc.file_name)}
                    className="shrink-0 ml-4 transition-colors"
                    style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: '"Barlow Condensed", sans-serif', fontWeight: 600, letterSpacing: "1px", textTransform: "uppercase", background: "none", border: "none", cursor: "pointer" }}
                    onMouseEnter={(e) => (e.currentTarget.style.color = "#c0392b")}
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
    </div>
  );
}
