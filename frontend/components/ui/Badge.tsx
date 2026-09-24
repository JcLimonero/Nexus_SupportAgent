"use client";
import React from "react";

type Tone = "accent" | "muted" | "success" | "danger";

const toneColors: Record<Tone, { color: string; bg: string }> = {
  accent:  { color: "var(--accent-fg)",  bg: "var(--accent-tint)" },
  muted:   { color: "var(--text-muted)", bg: "var(--bg-muted)" },
  success: { color: "var(--success)",    bg: "var(--success-bg)" },
  danger:  { color: "var(--danger-fg)",  bg: "var(--danger-bg)" },
};

/** Small uppercase pill — file-type tags, role/status markers, etc. */
export function Badge({ tone = "muted", children }: { tone?: Tone; children: React.ReactNode }) {
  const c = toneColors[tone];
  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        color: c.color,
        backgroundColor: c.bg,
        borderRadius: "var(--radius-pill)",
        padding: "2px 8px",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}
