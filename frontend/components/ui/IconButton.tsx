"use client";
import React from "react";

type Tone = "default" | "accent" | "danger";

export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Required — icon-only buttons must be labelled for screen readers. */
  label: string;
  tone?: Tone;
}

/**
 * Icon-only button. `label` becomes both aria-label and the native tooltip.
 * Hover tinting is handled by `.nqt-iconbtn*` CSS classes.
 */
export function IconButton({
  label,
  tone = "default",
  className = "",
  type = "button",
  children,
  ...rest
}: IconButtonProps) {
  const toneClass = tone === "default" ? "" : `nqt-iconbtn--${tone}`;
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={`nqt-iconbtn ${toneClass} ${className}`.trim()}
      {...rest}
    >
      {children}
    </button>
  );
}
