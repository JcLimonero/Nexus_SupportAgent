"use client";
import { useEffect, useRef, useState } from "react";
import { getExcerpt, getDocumentBlobUrl } from "@/lib/api";
import type { PdfSource } from "./MessageBubble";

interface ExcerptData {
  chunk_id: string;
  file_name: string;
  source_type: string;
  page_number: number | null;
  content: string;
}

export function SourcePanel({
  source,
  onClose,
}: {
  source: PdfSource | null;
  onClose: () => void;
}) {
  const [data, setData] = useState<ExcerptData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [opening, setOpening] = useState(false);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const currentGcsUrlRef = useRef<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!source?.chunk_id) { setData(null); return; }
    setLoading(true);
    setError("");
    getExcerpt(source.chunk_id)
      .then(setData)
      .catch(() => setError("No se pudo cargar el fragmento."))
      .finally(() => setLoading(false));
  }, [source?.chunk_id]);

  // Reset video player when source file changes (gcs_url covers both PDFs and videos)
  useEffect(() => {
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    setVideoUrl(null);
    setOpening(false);
    setError("");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source?.gcs_url]);

  // Escape to close + focus trap. While open, focus is held inside the panel
  // and restored to the previously focused element when it closes.
  useEffect(() => {
    if (!source) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    const focusable = 'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';
    const t = setTimeout(() => {
      const nodes = panelRef.current?.querySelectorAll<HTMLElement>(focusable);
      (nodes && nodes.length ? nodes[0] : panelRef.current)?.focus();
    }, 0);

    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") { onClose(); return; }
      if (e.key !== "Tab") return;
      const nodes = panelRef.current?.querySelectorAll<HTMLElement>(focusable);
      if (!nodes || nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", handler);
    return () => {
      clearTimeout(t);
      window.removeEventListener("keydown", handler);
      restoreRef.current?.focus?.();
    };
  }, [source, onClose]);

  // Sync ref on every render so async callbacks can detect stale fetches
  currentGcsUrlRef.current = source?.gcs_url ?? null;

  if (!source) return null;

  const isLocal = source.gcs_url.startsWith("/data/");
  // Only MP4 uses the inline player; every other type (pdf, docx, pptx, txt,
  // md, csv) opens/downloads in a new tab.
  const isVideo = source.file_name.toLowerCase().endsWith(".mp4");

  const openDocument = async () => {
    if (!isLocal) {
      window.open(source.gcs_url, "_blank");
      return;
    }
    const fetchFor = source.gcs_url;
    setOpening(true);
    setError("");
    try {
      const blobUrl = await getDocumentBlobUrl(source.gcs_url);
      if (currentGcsUrlRef.current !== fetchFor) { URL.revokeObjectURL(blobUrl); return; }
      if (isVideo) {
        setVideoUrl(blobUrl);
      } else {
        window.open(blobUrl, "_blank");
      }
    } catch {
      if (currentGcsUrlRef.current === fetchFor) setError("No se pudo cargar el archivo.");
    } finally {
      if (currentGcsUrlRef.current === fetchFor) setOpening(false);
    }
  };

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40"
        style={{ backgroundColor: "rgba(5,15,26,0.6)", backdropFilter: "blur(2px)", animation: "nqt-fadeIn 0.2s ease both" }}
        onClick={onClose}
      />

      {/* Slide-in panel */}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={source.file_name}
        tabIndex={-1}
        className="fixed top-0 right-0 bottom-0 z-50 flex flex-col"
        style={{
          width: "min(500px, 100vw)",
          backgroundColor: "var(--bg-surface)",
          borderLeft: "1px solid var(--border-default)",
          boxShadow: "-8px 0 32px rgba(0,0,0,0.25)",
          animation: "nqt-slideInRight 0.35s cubic-bezier(0.16, 1, 0.3, 1) both",
          outline: "none",
        }}
      >
        {/* Header */}
        <div
          className="px-5 py-4 shrink-0"
          style={{ background: "linear-gradient(135deg, #050f1a 0%, #0a2540 100%)", borderBottom: "1px solid #1e3a5f" }}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
                <div style={{ width: 3, height: 16, backgroundColor: "var(--nqt-blue, #0ea5e9)", borderRadius: 2 }} />
                <p style={{ fontFamily: "var(--font-condensed)", fontWeight: 600, fontSize: 10, color: "#64748b", textTransform: "uppercase", letterSpacing: "2px" }}>
                  {isVideo ? "Video de referencia" : "Fragmento de contexto"}
                </p>
              </div>
              <p
                title={source.file_name}
                style={{ fontFamily: "var(--font-condensed)", fontWeight: 700, fontSize: 15, color: "#ffffff", letterSpacing: "0.5px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
              >
                {source.file_name}
              </p>
              {source.page_number != null && (
                <p style={{ fontSize: 11, color: "#475569", fontFamily: "var(--font-condensed)", letterSpacing: 1, marginTop: 3 }}>
                  Página {source.page_number}
                </p>
              )}
            </div>
            <button
              onClick={onClose}
              aria-label="Cerrar panel"
              style={{ color: "#475569", background: "none", border: "none", cursor: "pointer", padding: 4, flexShrink: 0, marginTop: 2, lineHeight: 1, borderRadius: "var(--radius-sm)" }}
              onMouseEnter={(e) => (e.currentTarget.style.color = "#ffffff")}
              onMouseLeave={(e) => (e.currentTarget.style.color = "#475569")}
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="1" y1="1" x2="13" y2="13" />
                <line x1="13" y1="1" x2="1" y2="13" />
              </svg>
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-5 py-5">
          {/* Inline video player */}
          {videoUrl && isVideo && (
            <div style={{ marginBottom: 20, borderRadius: "var(--radius)", overflow: "hidden", border: "1px solid var(--border-default)" }}>
              <video
                controls
                autoPlay
                style={{ width: "100%", backgroundColor: "#000", display: "block" }}
                src={videoUrl}
              >
                Tu navegador no soporta video HTML5.
              </video>
            </div>
          )}

          {loading && (
            <p style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-condensed)", letterSpacing: "2px", textTransform: "uppercase" }}>
              Cargando...
            </p>
          )}
          {error && !loading && (
            <p style={{ fontSize: 12, color: "#f87171", backgroundColor: "rgba(248,113,113,0.08)", padding: "8px 12px", borderRadius: "var(--radius-sm)", border: "1px solid rgba(248,113,113,0.2)", fontWeight: 300 }}>
              {error}
            </p>
          )}
          {!source.chunk_id && !loading && (
            <p style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 300, lineHeight: 1.65 }}>
              Este fragmento no tiene un ID registrado (respuesta anterior a Phase 7).
            </p>
          )}
          {data && !loading && (
            <>
              <p style={{ fontFamily: "var(--font-condensed)", fontWeight: 600, fontSize: 10, color: "var(--text-faint)", letterSpacing: "2px", textTransform: "uppercase", marginBottom: 14 }}>
                Texto extraído por el modelo
              </p>
              <p style={{ fontSize: 13, fontWeight: 300, color: "var(--text-secondary)", lineHeight: 1.8, whiteSpace: "pre-wrap", borderLeft: "2px solid var(--nqt-blue, #0ea5e9)", paddingLeft: 14 }}>
                {data.content}
              </p>
            </>
          )}
        </div>

        {/* Footer */}
        <div
          className="px-5 py-4 shrink-0 flex items-center justify-between"
          style={{ borderTop: "1px solid var(--border-default)", backgroundColor: "var(--bg-muted)" }}
        >
          {!videoUrl && (
            <button
              onClick={openDocument}
              disabled={opening}
              style={{
                fontFamily: "var(--font-condensed)",
                fontWeight: 700,
                fontSize: 11,
                letterSpacing: "1.5px",
                textTransform: "uppercase",
                backgroundColor: "var(--btn-primary-bg)",
                color: "var(--btn-primary-text)",
                border: "none",
                borderRadius: "var(--radius-sm)",
                padding: "7px 16px",
                cursor: opening ? "not-allowed" : "pointer",
                opacity: opening ? 0.5 : 1,
                transition: "background-color 0.15s",
              }}
              onMouseEnter={(e) => { if (!opening) e.currentTarget.style.backgroundColor = "var(--btn-primary-hover)"; }}
              onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "var(--btn-primary-bg)")}
            >
              {opening
                ? isVideo ? "Cargando..." : "Abriendo..."
                : isVideo ? "Ver video" : "Ver documento"}
            </button>
          )}
          <button
            onClick={onClose}
            style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: "var(--font-condensed)", fontWeight: 600, letterSpacing: "1.5px", textTransform: "uppercase", background: "none", border: "none", cursor: "pointer", marginLeft: "auto" }}
            onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text-primary)")}
            onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-muted)")}
          >
            Cerrar
          </button>
        </div>
      </div>
    </>
  );
}
