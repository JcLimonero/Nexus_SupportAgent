"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { ThemeToggle } from "@/components/ThemeToggle";
import { getAdminBanners, getEscalations } from "@/lib/api";

// ── Sections ─────────────────────────────────────────────────────────────────

export type AdminIconName = "overview" | "users" | "conversations" | "escalations" | "notices";

export interface AdminCounts {
  escalations: number;   // new (untriaged) support requests
  avisos: number;        // service banners live right now
}

const SECTIONS: { href: string; label: string; icon: AdminIconName; count?: keyof AdminCounts }[] = [
  { href: "/admin", label: "Resumen", icon: "overview" },
  { href: "/admin/users", label: "Usuarios", icon: "users" },
  { href: "/admin/conversations", label: "Conversaciones", icon: "conversations" },
  { href: "/admin/escalations", label: "Escalaciones", icon: "escalations", count: "escalations" },
  { href: "/admin/avisos", label: "Avisos", icon: "notices", count: "avisos" },
];

/** "/admin" matches only itself; every other section also owns its sub-paths. */
export function isActiveSection(pathname: string, href: string): boolean {
  if (href === "/admin") return pathname === "/admin";
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** Counters for the tab badges. Failures read as 0 — a badge is a hint, never a blocker. */
export function useAdminCounts(enabled = true): AdminCounts | null {
  const [counts, setCounts] = useState<AdminCounts | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    (async () => {
      const [escalations, banners] = await Promise.allSettled([getEscalations("new"), getAdminBanners()]);
      if (!alive) return;
      setCounts({
        escalations: escalations.status === "fulfilled" ? escalations.value.new_count : 0,
        avisos: banners.status === "fulfilled" ? banners.value.active.length : 0,
      });
    })();
    return () => {
      alive = false;
    };
  }, [enabled]);
  return counts;
}

// ── Icons (inline, same stroke style as the rest of the app) ─────────────────

export function AdminIcon({ name, size = 16 }: { name: AdminIconName; size?: number }) {
  const common = {
    width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
    strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true,
  };
  switch (name) {
    case "overview":
      return (
        <svg {...common}>
          <rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" />
          <rect x="14" y="14" width="7" height="7" /><rect x="3" y="14" width="7" height="7" />
        </svg>
      );
    case "users":
      return (
        <svg {...common}>
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" />
          <path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
      );
    case "conversations":
      return (
        <svg {...common}>
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      );
    case "escalations":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="4" />
          <line x1="4.93" y1="4.93" x2="9.17" y2="9.17" /><line x1="14.83" y1="14.83" x2="19.07" y2="19.07" />
          <line x1="14.83" y1="9.17" x2="19.07" y2="4.93" /><line x1="4.93" y1="19.07" x2="9.17" y2="14.83" />
        </svg>
      );
    case "notices":
      return (
        <svg {...common}>
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
      );
  }
}

// ── Header ───────────────────────────────────────────────────────────────────

/**
 * Shared header for every admin page: title, theme toggle, a way back to the
 * chat, and the section tab bar. The tabs are links (they navigate) styled as
 * outlined buttons, with the current page highlighted and live counters.
 *
 * Pass `counts` when the page already knows a number (e.g. after triaging an
 * escalation) so the badge updates immediately; anything not passed is fetched.
 */
export function AdminHeader({
  title,
  subtitle,
  maxWidth = "max-w-5xl",
  counts,
  children,
}: {
  title: string;
  subtitle?: React.ReactNode;
  maxWidth?: string;
  counts?: Partial<AdminCounts>;
  children?: React.ReactNode;
}) {
  const pathname = usePathname() ?? "";
  const complete = counts?.escalations != null && counts?.avisos != null;
  const fetched = useAdminCounts(!complete);
  const merged: AdminCounts = {
    escalations: counts?.escalations ?? fetched?.escalations ?? 0,
    avisos: counts?.avisos ?? fetched?.avisos ?? 0,
  };

  return (
    <header style={{ background: "linear-gradient(135deg, #050f1a 0%, #0a2540 100%)", borderBottom: "1px solid #1e3a5f" }}>
      <div className={`${maxWidth} mx-auto px-4 md:px-8 pt-5`}>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
              <div style={{ width: 3, height: 18, backgroundColor: "var(--nqt-blue, #0ea5e9)", borderRadius: 2 }} />
              <h1 style={{ fontFamily: "var(--font-condensed)", fontWeight: 700, fontSize: 22, color: "#ffffff", letterSpacing: "0.5px" }}>
                {title}
              </h1>
            </div>
            {subtitle && (
              <p style={{ fontSize: 12, color: "#94a3b8", marginTop: 2, fontWeight: 300, paddingLeft: 11 }}>{subtitle}</p>
            )}
            {children}
          </div>
          <div className="flex items-center gap-3 mt-1 shrink-0">
            <ThemeToggle
              className="p-1 transition-colors"
              style={{ color: "#94a3b8", background: "none", border: "none", cursor: "pointer" } as React.CSSProperties}
            />
            <Link href="/chat" className="admin-back-link">
              ← Chat
            </Link>
          </div>
        </div>

        {/* Whole buttons wrap onto a second row on narrow screens — no side
            scroller, and labels never break mid-word. */}
        <nav aria-label="Secciones de administración" style={{ marginTop: 16, paddingBottom: 14 }}>
          <ul className="flex flex-wrap gap-2">
            {SECTIONS.map((s) => {
              const active = isActiveSection(pathname, s.href);
              const n = s.count ? merged[s.count] : 0;
              return (
                <li key={s.href}>
                  <Link href={s.href} className="admin-nav-tab" aria-current={active ? "page" : undefined}>
                    <AdminIcon name={s.icon} />
                    <span>{s.label}</span>
                    {n > 0 && (
                      <span className="admin-nav-count" data-tone={s.count}>
                        {n}
                      </span>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      </div>
    </header>
  );
}
