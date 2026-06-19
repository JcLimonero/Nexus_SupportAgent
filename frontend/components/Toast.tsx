"use client";
import { createContext, useContext, useState, useCallback, useRef } from "react";

type ToastKind = "success" | "error" | "info";

interface ToastItem {
  id: number;
  text: string;
  kind: ToastKind;
  exiting: boolean;
}

interface ToastCtx {
  toast: (text: string, kind?: ToastKind) => void;
}

const ToastContext = createContext<ToastCtx>({ toast: () => {} });

const VISIBLE_MS  = 3600;
const EXIT_MS     = 400;
const TOTAL_MS    = VISIBLE_MS + EXIT_MS;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const counter = useRef(0);

  const toast = useCallback((text: string, kind: ToastKind = "info") => {
    const id = ++counter.current;
    setToasts((prev) => [...prev, { id, text, kind, exiting: false }]);
    // Start exit animation
    setTimeout(() => {
      setToasts((prev) => prev.map((t) => t.id === id ? { ...t, exiting: true } : t));
    }, VISIBLE_MS);
    // Remove from DOM
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, TOTAL_MS);
  }, []);

  const dismiss = (id: number) => {
    setToasts((prev) => prev.map((t) => t.id === id ? { ...t, exiting: true } : t));
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), EXIT_MS);
  };

  const borderColor = (k: ToastKind) =>
    k === "success" ? "#22c55e" : k === "error" ? "#f87171" : "var(--nqt-blue, #0ea5e9)";
  const bgColor = (k: ToastKind) =>
    k === "success" ? "rgba(34,197,94,0.08)" : k === "error" ? "rgba(248,113,113,0.08)" : "var(--bg-surface)";
  const textColor = (k: ToastKind) =>
    k === "success" ? "#22c55e" : k === "error" ? "#f87171" : "var(--text-primary)";
  const icon = (k: ToastKind) =>
    k === "success" ? "✓" : k === "error" ? "✕" : "·";

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div role="status" aria-live="polite" aria-atomic="false" style={{ position: "fixed", bottom: 24, right: 24, zIndex: 9999, display: "flex", flexDirection: "column", gap: 8, maxWidth: 360, minWidth: 260 }}>
        {toasts.map((t) => (
          <div
            key={t.id}
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 10,
              borderLeft: `3px solid ${borderColor(t.kind)}`,
              backgroundColor: bgColor(t.kind),
              color: textColor(t.kind),
              padding: "10px 12px 10px 14px",
              fontSize: 13,
              fontWeight: 300,
              boxShadow: "0 4px 16px rgba(0,0,0,0.2)",
              borderRadius: `0 var(--radius) var(--radius) 0`,
              animation: t.exiting
                ? `nqt-toastOut ${EXIT_MS}ms ease forwards`
                : "nqt-toastIn 0.3s cubic-bezier(0.16, 1, 0.3, 1) both",
              cursor: "default",
            }}
          >
            <span style={{ fontFamily: "var(--font-condensed)", fontWeight: 700, fontSize: 12, flexShrink: 0, marginTop: 1 }}>
              {icon(t.kind)}
            </span>
            <span style={{ flex: 1, lineHeight: 1.5 }}>{t.text}</span>
            <button
              onClick={() => dismiss(t.id)}
              style={{ background: "none", border: "none", cursor: "pointer", color: "inherit", opacity: 0.5, padding: "0 0 0 4px", lineHeight: 1, fontSize: 14, flexShrink: 0 }}
              onMouseEnter={(e) => (e.currentTarget.style.opacity = "1")}
              onMouseLeave={(e) => (e.currentTarget.style.opacity = "0.5")}
              aria-label="Cerrar"
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
