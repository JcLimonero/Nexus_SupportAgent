"use client";
import React from "react";

/** Condensed uppercase section label (the recurring `.gv-label`-style heading). */
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
      <span className="gv-label">{children}</span>
      {count != null && (
        <span
          style={{
            marginLeft: 8,
            fontSize: 10,
            color: "var(--text-faint)",
            fontFamily: "var(--font-condensed)",
          }}
        >
          ({count})
        </span>
      )}
    </span>
  );
}
