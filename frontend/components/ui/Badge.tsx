"use client";
import React from "react";

type Tone = "blue" | "cyan" | "muted" | "success" | "danger";

const toneColors: Record<Tone, { color: string; bg: string; border: string }> = {
  blue:    { color: "var(--nqt-blue, #0ea5e9)", bg: "rgba(14,165,233,0.1)", border: "rgba(14,165,233,0.3)" },
  cyan:    { color: "var(--nqt-cyan, #06b6d4)", bg: "rgba(6,182,212,0.1)",  border: "rgba(6,182,212,0.3)" },
  muted:   { color: "var(--text-muted)",        bg: "transparent",          border: "var(--border-default)" },
  success: { color: "#4a7c4a",                  bg: "transparent",          border: "#4a7c4a" },
  danger:  { color: "#c0392b",                  bg: "transparent",          border: "#c0392b" },
};

/** Small condensed uppercase pill — file-type tags, role/status markers, etc. */
export function Badge({ tone = "muted", children }: { tone?: Tone; children: React.ReactNode }) {
  const c = toneColors[tone];
  return (
    <span
      style={{
        fontFamily: "var(--font-condensed)",
        fontSize: 9,
        fontWeight: 700,
        letterSpacing: "1.5px",
        textTransform: "uppercase",
        color: c.color,
        backgroundColor: c.bg,
        border: `1px solid ${c.border}`,
        borderRadius: "3px",
        padding: "1px 6px",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}
