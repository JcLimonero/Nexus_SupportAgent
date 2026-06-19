"use client";
import React from "react";

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Adds the signature 3px blue left-accent border. */
  accent?: boolean;
}

/** Surface container matching the app's card styling (border + radius). */
export function Card({ accent = false, className = "", children, ...rest }: CardProps) {
  return (
    <div className={`nqt-card ${accent ? "nqt-card--accent" : ""} ${className}`.trim()} {...rest}>
      {children}
    </div>
  );
}
