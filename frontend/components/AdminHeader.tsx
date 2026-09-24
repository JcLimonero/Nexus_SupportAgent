"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { ThemeToggle } from "@/components/ThemeToggle";
import { BrandLogo } from "@/components/BrandLogo";
import { useAuth } from "@/lib/AuthProvider";
import { getAdminBanners, getEscalations } from "@/lib/api";

// ── Sections ─────────────────────────────────────────────────────────────────

export type AdminIconName = "overview" | "users" | "conversations" | "escalations" | "notices";

export interface AdminCounts {
  escalations: number;   // new (untriaged) support requests
  avisos: number;        // service banners live right now
}

/** What a page tells the header about each count. A number — or `null` while
 *  the page's own request is still in flight — claims it: the header won't ask
 *  for that number itself. Leaving a key out hands it to the header. */
export type SuppliedCounts = { [K in keyof AdminCounts]?: number | null };

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

/** Counters for the tab badges, fetching only the ones asked for — /admin/avisos
 *  and /admin/escalations already load the very list a count comes from, so
 *  requesting it again there is a second call for a number they have.
 *  Failures read as 0 — a badge is a hint, never a blocker. */
export function useAdminCounts(need: { escalations: boolean; avisos: boolean }): SuppliedCounts {
  // Destructured: the caller builds a fresh object every render, so the effect
  // has to depend on the two booleans, not the object holding them.
  const { escalations: needEscalations, avisos: needAvisos } = need;
  const [counts, setCounts] = useState<SuppliedCounts>({});
  useEffect(() => {
    if (!needEscalations && !needAvisos) return;
    let alive = true;
    (async () => {
      const [escalations, banners] = await Promise.allSettled([
        needEscalations ? getEscalations("new") : Promise.resolve(null),
        needAvisos ? getAdminBanners() : Promise.resolve(null),
      ]);
      if (!alive) return;
      const next: SuppliedCounts = {};
      if (needEscalations) {
        next.escalations = escalations.status === "fulfilled" && escalations.value ? escalations.value.new_count : 0;
      }
      if (needAvisos) {
        next.avisos = banners.status === "fulfilled" && banners.value ? banners.value.active.length : 0;
      }
      setCounts(next);
    })();
    return () => {
      alive = false;
    };
  }, [needEscalations, needAvisos]);
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
 * chat, and the section tab bar. The tabs are links styled like the
 * totaldealer.com.mx top nav, with the current page underlined and live counters.
 *
 * Pass a number in `counts` when the page already knows it (e.g. after triaging
 * an escalation) so the badge updates immediately, and `null` for a count the
 * page owns but hasn't loaded yet — either way we won't request it ourselves.
 * Omit a key to hand that count to us. A page that loads one of these lists
 * anyway (/admin/avisos, /admin/escalations) should always claim its own, or
 * every visit pays for the same endpoint twice.
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
  counts?: SuppliedCounts;
  children?: React.ReactNode;
}) {
  const pathname = usePathname() ?? "";
  const { user } = useAuth();
  // Decided once, at mount, per count. Re-deriving on every render would refire
  // the fetch whenever `counts` flickers back to an incomplete shape (a page's
  // own reload, a filter change) instead of only when this header first appears.
  const [needs] = useState(() => ({
    escalations: counts?.escalations === undefined,
    avisos: counts?.avisos === undefined,
  }));
  // Gate on confirmed admin status, same as the per-page checks this header
  // replaced — otherwise a signed-in non-admin (or a guest) rendering one of
  // these routes for the instant before its redirect fires would still call
  // the require_admin-guarded escalations/banners endpoints. `user` starts
  // `null` until AuthProvider's own effect resolves the token, so this stays
  // reactive rather than a one-time decision: it fetches once `is_admin`
  // flips true, same as it always would have for an actual admin.
  const isAdmin = !!user?.is_admin;
  const fetched = useAdminCounts({
    escalations: needs.escalations && isAdmin,
    avisos: needs.avisos && isAdmin,
  });
  const merged: AdminCounts = {
    escalations: counts?.escalations ?? fetched.escalations ?? 0,
    avisos: counts?.avisos ?? fetched.avisos ?? 0,
  };

  return (
    <header
      className="sticky top-0 z-30"
      style={{ backgroundColor: "var(--bg-header)", borderBottom: "1px solid var(--border-default)" }}
    >
      <div className={`${maxWidth} mx-auto px-4 md:px-8 pt-4`}>
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-4 min-w-0">
            <Link href="/admin" aria-label="Inicio de administración" className="hidden sm:block shrink-0" style={{ paddingTop: 2 }}>
              <BrandLogo height={34} />
            </Link>
            <div className="min-w-0 sm:pl-4" style={{ borderLeft: "1px solid var(--border-default)" }}>
              <p style={{ fontSize: 13, fontWeight: 500, color: "var(--text-muted)" }}>Administración</p>
              <h1 style={{ fontWeight: 700, fontSize: 22, letterSpacing: "-0.02em", color: "var(--text-primary)", lineHeight: 1.2, marginTop: 2 }}>
                {title}
              </h1>
              {subtitle && (
                <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 2 }}>{subtitle}</p>
              )}
              {children}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <ThemeToggle className="nqt-iconbtn" />
            <Link href="/chat" className="admin-back-link">
              ← Chat
            </Link>
          </div>
        </div>

        {/* Links wrap onto a second row on narrow screens — no side scroller,
            and labels never break mid-word. */}
        <nav aria-label="Secciones de administración" style={{ marginTop: 10 }}>
          <ul className="flex flex-wrap gap-x-6 gap-y-0">
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
