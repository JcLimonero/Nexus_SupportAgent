"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  canDismiss,
  dismissKey,
  elapsedLabel,
  etaLabel,
  fetchPublicStatus,
  formatWhen,
  jitter,
  lastKnownContact,
  OFFLINE_MESSAGE,
  POLL_MS,
  readDismissed,
  rememberContact,
  RETRY_MS,
  saveDismissed,
  SEVERITY_LABEL,
  StatusUnreachableError,
  telHref,
  type PublicStatus,
  type Severity,
  type StatusBanner as Banner,
} from "@/lib/status";

// ── Provider ─────────────────────────────────────────────────────────────────

interface ServiceStatusValue {
  status: PublicStatus | null;
  /** The backend itself can't be reached — no banner from it can arrive. */
  unreachable: boolean;
  /** Sending chat messages is paused (a blocking banner, or unreachable). */
  chatBlocked: boolean;
  refresh: () => void;
  /** Call when a real request fails, to re-check now instead of at the next poll. */
  reportServiceError: () => void;
}

const ServiceStatusContext = createContext<ServiceStatusValue>({
  status: null,
  unreachable: false,
  chatBlocked: false,
  refresh: () => {},
  reportServiceError: () => {},
});

/** Two failed polls in a row before declaring the service unreachable — one
 * dropped request on a flaky office network shouldn't pause everyone's chat. */
const UNREACHABLE_AFTER = 2;

export function ServiceStatusProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<PublicStatus | null>(null);
  const [failures, setFailures] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inflight = useRef<AbortController | null>(null);
  const lastReport = useRef(0);

  const poll = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    inflight.current?.abort();
    const controller = new AbortController();
    inflight.current = controller;
    let delay = POLL_MS;
    try {
      const next = await fetchPublicStatus(controller.signal);
      setStatus(next);
      setFailures(0);
      rememberContact(next.banners);
    } catch (err) {
      if (controller.signal.aborted) return; // superseded by a newer poll
      if (err instanceof StatusUnreachableError) {
        setFailures((f) => f + 1);
        delay = RETRY_MS;
      }
    }
    inflight.current = null;
    // Hidden tabs stop polling; the visibility listener catches up on return.
    timer.current = setTimeout(() => {
      if (!document.hidden) poll();
    }, jitter(delay));
  }, []);

  useEffect(() => {
    poll();
    const onReturn = () => {
      if (!document.hidden) poll();
    };
    document.addEventListener("visibilitychange", onReturn);
    window.addEventListener("online", onReturn);
    return () => {
      document.removeEventListener("visibilitychange", onReturn);
      window.removeEventListener("online", onReturn);
      if (timer.current) clearTimeout(timer.current);
      inflight.current?.abort();
    };
  }, [poll]);

  const reportServiceError = useCallback(() => {
    const now = Date.now();
    if (now - lastReport.current < 3000) return;
    lastReport.current = now;
    poll();
  }, [poll]);

  const unreachable = failures >= UNREACHABLE_AFTER;
  const value = useMemo<ServiceStatusValue>(
    () => ({
      status,
      unreachable,
      chatBlocked: unreachable || !!status?.chat_blocked,
      refresh: poll,
      reportServiceError,
    }),
    [status, unreachable, poll, reportServiceError],
  );

  return <ServiceStatusContext.Provider value={value}>{children}</ServiceStatusContext.Provider>;
}

export const useServiceStatus = () => useContext(ServiceStatusContext);

// ── Presentation ─────────────────────────────────────────────────────────────

const TONE: Record<Severity, { accent: string; text: string; bg: string }> = {
  critical: { accent: "var(--status-critical-accent)", text: "var(--status-critical)", bg: "var(--status-critical-bg)" },
  warning: { accent: "var(--status-warning-accent)", text: "var(--status-warning)", bg: "var(--status-warning-bg)" },
  info: { accent: "var(--status-ok-accent)", text: "var(--status-info)", bg: "var(--status-ok-bg)" },
};

// text-secondary, not text-muted: the muted token is ~2:1 on the tinted strip in
// dark mode, and these lines carry the ETA and the contact.
const metaStyle: React.CSSProperties = { fontSize: 11, color: "var(--text-secondary)", fontWeight: 400, lineHeight: 1.5 };

function SeverityIcon({ severity }: { severity: Severity }) {
  if (severity === "info") {
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" />
      </svg>
    );
  }
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

function Frame({
  severity,
  label,
  aside,
  onDismiss,
  children,
}: {
  severity: Severity;
  label: string;
  aside?: React.ReactNode;
  onDismiss?: () => void;
  children: React.ReactNode;
}) {
  const tone = TONE[severity];
  return (
    <div
      role={severity === "critical" ? "alert" : "status"}
      data-testid="status-banner"
      data-severity={severity}
      style={{ backgroundColor: "var(--bg-surface)", borderBottom: "1px solid var(--border-default)" }}
    >
      <div className="px-4 md:px-8 py-2.5" style={{ backgroundColor: tone.bg, borderLeft: `4px solid ${tone.accent}` }}>
        <div className="flex items-start gap-3 max-w-5xl mx-auto">
          <span style={{ color: tone.accent, marginTop: 2, flexShrink: 0 }}>
            <SeverityIcon severity={severity} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-x-3 flex-wrap">
              <span style={{ fontWeight: 700, fontSize: 10, letterSpacing: "0.06em", textTransform: "uppercase", color: tone.text }}>
                {label}
              </span>
              {aside}
            </div>
            {children}
          </div>
          {onDismiss && (
            <button
              type="button"
              onClick={onDismiss}
              aria-label="Cerrar aviso"
              title="Cerrar aviso"
              style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", fontSize: 18, lineHeight: 1, padding: "0 4px", flexShrink: 0 }}
            >
              ×
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** One banner as users see it. Also used for the admin preview and lists. */
export function BannerView({ banner, now, onDismiss }: { banner: Banner; now: Date; onDismiss?: () => void }) {
  const [showOlder, setShowOlder] = useState(false);
  const latest = banner.updates[banner.updates.length - 1];
  const older = banner.updates.slice(0, -1).reverse();
  const eta = etaLabel(banner.eta_at, now);
  const tel = banner.contact ? telHref(banner.contact) : null;

  return (
    <Frame
      severity={banner.severity}
      label={SEVERITY_LABEL[banner.severity]}
      aside={<span style={metaStyle}>{elapsedLabel(banner.starts_at, now)}</span>}
      onDismiss={onDismiss}
    >
      <p style={{ fontSize: 13, color: "var(--text-primary)", lineHeight: 1.5, marginTop: 2, whiteSpace: "pre-wrap" }}>
        {banner.message}
      </p>

      {latest && (
        <p style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.5, marginTop: 4 }}>
          <span style={{ ...metaStyle, fontWeight: 600 }}>Actualización · {formatWhen(latest.at, now)} — </span>
          <span>{latest.text}</span>
        </p>
      )}

      {(eta || banner.contact) && (
        <p style={{ ...metaStyle, marginTop: 4 }}>
          {eta}
          {eta && banner.contact && " · "}
          {banner.contact && (
            <>
              Contacto:{" "}
              {tel ? (
                <a href={tel} style={{ color: "var(--text-primary)", fontWeight: 600, textDecoration: "underline" }}>
                  {banner.contact}
                </a>
              ) : (
                <strong style={{ color: "var(--text-primary)" }}>{banner.contact}</strong>
              )}
            </>
          )}
        </p>
      )}

      {banner.blocks_chat && (
        <p style={{ ...metaStyle, marginTop: 4 }}>El envío de mensajes está pausado mientras se restablece el servicio.</p>
      )}

      {older.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setShowOlder((v) => !v)}
            style={{ ...metaStyle, background: "none", border: "none", padding: 0, marginTop: 4, cursor: "pointer", textDecoration: "underline" }}
          >
            {showOlder
              ? "Ocultar actualizaciones anteriores"
              : older.length === 1
                ? "Ver 1 actualización anterior"
                : `Ver ${older.length} actualizaciones anteriores`}
          </button>
          {showOlder && (
            <ul style={{ marginTop: 4 }}>
              {older.map((u, i) => (
                <li key={`${u.at}-${i}`} style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.5 }}>
                  <span style={{ ...metaStyle, fontWeight: 600 }}>{formatWhen(u.at, now)} — </span>
                  <span>{u.text}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Frame>
  );
}

/** Built-in fallback for when the backend is down and can't serve a banner. */
function OfflineBanner({ onRetry }: { onRetry: () => void }) {
  const [contact, setContact] = useState<string | null>(null);
  useEffect(() => setContact(lastKnownContact()), []);
  const tel = contact ? telHref(contact) : null;

  return (
    <Frame severity="critical" label="Sin conexión con el servicio">
      <p style={{ fontSize: 13, color: "var(--text-primary)", lineHeight: 1.5, marginTop: 2 }}>{OFFLINE_MESSAGE}</p>
      <p style={{ ...metaStyle, marginTop: 4 }}>
        {contact && (
          <>
            Mientras tanto puede comunicarse al{" "}
            {tel ? (
              <a href={tel} style={{ color: "var(--text-primary)", fontWeight: 600, textDecoration: "underline" }}>{contact}</a>
            ) : (
              <strong style={{ color: "var(--text-primary)" }}>{contact}</strong>
            )}
            {" · "}
          </>
        )}
        <button
          type="button"
          onClick={onRetry}
          style={{ ...metaStyle, background: "none", border: "none", padding: 0, cursor: "pointer", textDecoration: "underline", fontWeight: 600 }}
        >
          Reintentar
        </button>
      </p>
    </Frame>
  );
}

/** The strip above every page. Takes real layout space (see app/layout.tsx), so
 * it never covers the chat input. */
export function StatusBanner() {
  const { status, unreachable, refresh } = useServiceStatus();
  const [now, setNow] = useState(() => new Date());
  const [dismissed, setDismissed] = useState<string[]>([]);

  useEffect(() => {
    setDismissed(readDismissed());
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => setNow(new Date()), [status]);

  if (unreachable) {
    return (
      <div className="shrink-0">
        <OfflineBanner onRetry={refresh} />
      </div>
    );
  }

  const visible = (status?.banners ?? []).filter((b) => !(canDismiss(b) && dismissed.includes(dismissKey(b))));
  if (visible.length === 0) return null;

  return (
    <div className="shrink-0" data-testid="status-banners">
      {visible.map((b) => (
        <BannerView
          key={b.id}
          banner={b}
          now={now}
          onDismiss={
            canDismiss(b)
              ? () => {
                  const next = [...dismissed, dismissKey(b)];
                  setDismissed(next);
                  saveDismissed(next);
                }
              : undefined
          }
        />
      ))}
    </div>
  );
}
