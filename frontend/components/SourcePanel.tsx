"use client";
import { useEffect, useState } from "react";
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

  useEffect(() => {
    if (!source?.chunk_id) { setData(null); return; }
    setLoading(true);
    setError("");
    getExcerpt(source.chunk_id)
      .then(setData)
      .catch(() => setError("No se pudo cargar el fragmento."))
      .finally(() => setLoading(false));
  }, [source?.chunk_id]);

  // Reset video player when source changes
  useEffect(() => {
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    setVideoUrl(null);
    setOpening(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source?.chunk_id]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  if (!source) return null;

  const isLocal = source.gcs_url.startsWith("/data/");
  const isPdf = source.file_name.toLowerCase().endsWith(".pdf");

  const openDocument = async () => {
    if (!isLocal) {
      window.open(source.gcs_url, "_blank");
      return;
    }
    setOpening(true);
    try {
      const blobUrl = await getDocumentBlobUrl(source.gcs_url);
      if (isPdf) {
        // PDFs open in a new tab — browser handles them natively
        window.open(blobUrl, "_blank");
      } else {
        // Videos play inline to avoid popup-blocker issues with window.open after await
        setVideoUrl(blobUrl);
      }
    } catch {
      // silent — serve endpoint may not exist in this env
    } finally {
      setOpening(false);
    }
  };

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40"
        style={{ backgroundColor: "rgba(0,0,0,0.45)" }}
        onClick={onClose}
      />

      {/* Slide-in panel */}
      <div
        className="fixed top-0 right-0 bottom-0 z-50 flex flex-col"
        style={{
          width: "min(480px, 100vw)",
          backgroundColor: "var(--bg-surface)",
          borderLeft: "1px solid var(--border-default)",
          boxShadow: "-4px 0 24px rgba(0,0,0,0.15)",
        }}
      >
        {/* Header — always dark */}
        <div
          className="px-5 py-4 shrink-0"
          style={{ backgroundColor: "var(--gv-black, #222222)", borderBottom: "1px solid #333" }}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div style={{ width: 24, height: 2, backgroundColor: "#98989A", marginBottom: 10 }} />
              <p style={{ fontFamily: '"Barlow Condensed", sans-serif', fontWeight: 600, fontSize: 10, color: "#98989A", textTransform: "uppercase", letterSpacing: "2.5px", marginBottom: 5 }}>
                {isPdf ? "Fragmento de contexto" : "Video de referencia"}
              </p>
              <p
                title={source.file_name}
                style={{ fontFamily: '"Barlow Condensed", sans-serif', fontWeight: 700, fontSize: 15, color: "#ffffff", textTransform: "uppercase", letterSpacing: "0.5px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
              >
                {source.file_name}
              </p>
              {source.page_number != null && (
                <p style={{ fontSize: 11, color: "#777", fontFamily: '"Barlow Condensed", sans-serif', letterSpacing: 1, marginTop: 3 }}>
                  Página {source.page_number}
                </p>
              )}
            </div>
            <button
              onClick={onClose}
              aria-label="Cerrar panel"
              style={{ color: "#777", background: "none", border: "none", cursor: "pointer", padding: 4, flexShrink: 0, marginTop: 2, lineHeight: 1 }}
              onMouseEnter={(e) => (e.currentTarget.style.color = "#ffffff")}
              onMouseLeave={(e) => (e.currentTarget.style.color = "#777")}
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
          {videoUrl && !isPdf && (
            <div style={{ marginBottom: 20 }}>
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
            <p style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: '"Barlow Condensed", sans-serif', letterSpacing: "2px", textTransform: "uppercase" }}>
              Cargando...
            </p>
          )}
          {error && !loading && (
            <p style={{ fontSize: 12, color: "#c0392b", fontWeight: 300 }}>{error}</p>
          )}
          {!source.chunk_id && !loading && (
            <p style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 300, lineHeight: 1.65 }}>
              Este fragmento no tiene un ID registrado (respuesta anterior a Phase 7).
            </p>
          )}
          {data && !loading && (
            <>
              <p style={{ fontFamily: '"Barlow Condensed", sans-serif', fontWeight: 600, fontSize: 10, color: "var(--text-faint)", letterSpacing: "2px", textTransform: "uppercase", marginBottom: 14 }}>
                Texto extraído por el modelo
              </p>
              <p style={{ fontSize: 13, fontWeight: 300, color: "var(--text-secondary)", lineHeight: 1.8, whiteSpace: "pre-wrap", borderLeft: "2px solid var(--border-strong)", paddingLeft: 14 }}>
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
                fontFamily: '"Barlow Condensed", sans-serif',
                fontWeight: 700,
                fontSize: 11,
                letterSpacing: "2px",
                textTransform: "uppercase",
                backgroundColor: "var(--btn-primary-bg)",
                color: "var(--btn-primary-text)",
                border: "none",
                padding: "8px 16px",
                cursor: opening ? "not-allowed" : "pointer",
                opacity: opening ? 0.5 : 1,
              }}
              onMouseEnter={(e) => { if (!opening) e.currentTarget.style.backgroundColor = "var(--btn-primary-hover)"; }}
              onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "var(--btn-primary-bg)")}
            >
              {opening
                ? isPdf ? "Abriendo..." : "Cargando video..."
                : isPdf ? "Ver documento" : "Ver video"}
            </button>
          )}
          <button
            onClick={onClose}
            style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: '"Barlow Condensed", sans-serif', fontWeight: 600, letterSpacing: "1.5px", textTransform: "uppercase", background: "none", border: "none", cursor: "pointer", marginLeft: "auto" }}
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
