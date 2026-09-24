"use client";
import React from "react";

/** Condensed uppercase section label (the recurring `.nqt-label`-style heading). */
export function SectionLabel({
  children,
  count,
  className = "",
}: {
  children: React.ReactNode;
  count?: number;
  className?: string;
}) {
  return (
    <span className={className}>
      <span className="nqt-label">{children}</span>
      {count != null && (
        <span
          style={{
            marginLeft: 8,
            fontSize: 10,
            color: "var(--text-faint)",
          }}
        >
          ({count})
        </span>
      )}
    </span>
  );
}
