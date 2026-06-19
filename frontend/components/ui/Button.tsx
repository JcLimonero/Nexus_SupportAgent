"use client";
import React from "react";

type Variant = "primary" | "ghost" | "danger";
type Size = "sm" | "md";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

/**
 * Branded button. Hover/active/disabled states live in `.nqt-btn*` CSS classes
 * (globals.css) so they theme centrally instead of via inline JS handlers.
 */
export function Button({
  variant = "primary",
  size = "md",
  className = "",
  type = "button",
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={`nqt-btn nqt-btn--${size} nqt-btn--${variant} ${className}`.trim()}
      {...rest}
    >
      {children}
    </button>
  );
}
