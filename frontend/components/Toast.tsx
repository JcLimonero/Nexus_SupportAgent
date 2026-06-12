"use client";
import { createContext, useContext, useState, useCallback, useRef } from "react";

type ToastKind = "success" | "error" | "info";

interface Toast {
  id: number;
  text: string;
  kind: ToastKind;
}

interface ToastCtx {
  toast: (text: string, kind?: ToastKind) => void;
}

const ToastContext = createContext<ToastCtx>({ toast: () => {} });

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const counter = useRef(0);

  const toast = useCallback((text: string, kind: ToastKind = "info") => {
    const id = ++counter.current;
    setToasts((prev) => [...prev, { id, text, kind }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4000);
  }, []);

  const borderColor = (k: ToastKind) =>
    k === "success" ? "#4a7c4a" : k === "error" ? "#c0392b" : "var(--border-strong)";
  const bgColor = (k: ToastKind) =>
    k === "success" ? "rgba(74,124,74,0.08)" : k === "error" ? "rgba(192,57,43,0.08)" : "var(--bg-surface)";
  const textColor = (k: ToastKind) =>
    k === "success" ? "#4a7c4a" : k === "error" ? "#c0392b" : "var(--text-primary)";

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div style={{ position: "fixed", bottom: 24, right: 24, zIndex: 9999, display: "flex", flexDirection: "column", gap: 8, maxWidth: 360 }}>
        {toasts.map((t) => (
          <div
            key={t.id}
            style={{
              borderLeft: `3px solid ${borderColor(t.kind)}`,
              backgroundColor: bgColor(t.kind),
              color: textColor(t.kind),
              padding: "10px 14px",
              fontSize: 13,
              fontWeight: 300,
              boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
              animation: "fadeIn 0.15s ease",
            }}
          >
            {t.text}
          </div>
        ))}
      </div>
      <style>{`@keyframes fadeIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }`}</style>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
