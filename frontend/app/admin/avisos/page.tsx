"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/AuthProvider";
import { AdminHeader } from "@/components/AdminHeader";
import { useToast } from "@/components/Toast";
import { BannerView, useServiceStatus } from "@/components/ServiceStatus";
import {
  addBannerUpdate,
  createBanner,
  deleteBanner,
  getAdminBanners,
  getStatusChecks,
  updateBanner,
  type BannerLists,
  type StatusCheck,
  type StatusChecks,
} from "@/lib/api";
import {
  bannerFormToInput,
  bannerToForm,
  EMPTY_BANNER_FORM,
  ETA_PRESETS,
  formatDuration,
  formatWhen,
  type AdminBanner,
  type BannerFormState,
  type BannerInput,
  type Severity,
  type StatusBanner,
} from "@/lib/status";

type Tab = "active" | "scheduled" | "past";

const SEVERITY_CHOICES: { key: Severity; label: string }[] = [
  { key: "info", label: "Información" },
  { key: "warning", label: "Advertencia" },
  { key: "critical", label: "Crítico" },
];

const SOURCE_LABEL: Record<StatusBanner["source"], string> = {
  manual: "Manual",
  monitor: "Monitor interno",
};

const EMPTY_TEXT: Record<Tab, string> = {
  active: "No hay avisos activos.",
  scheduled: "No hay avisos programados.",
  past: "Aún no hay avisos finalizados.",
};


// ── Styles (same inline-token approach as the other admin pages) ─────────────

const sectionLabel: React.CSSProperties = {
  fontFamily: "var(--font-condensed)", fontSize: 10, fontWeight: 600, letterSpacing: "2px",
  textTransform: "uppercase", color: "var(--text-muted)",
};
const card: React.CSSProperties = {
  backgroundColor: "var(--bg-surface)", border: "1px solid var(--border-default)", borderRadius: "var(--radius)",
};
const inputStyle: React.CSSProperties = {
  width: "100%", backgroundColor: "var(--input-bg)", border: "1px solid var(--input-border)",
  borderRadius: "var(--radius-sm)", color: "var(--text-primary)", fontSize: 13, fontWeight: 300, padding: "8px 10px",
};
const hint: React.CSSProperties = { fontSize: 11, color: "var(--text-faint)", fontWeight: 300 };

function chip(active: boolean): React.CSSProperties {
  return {
    fontFamily: "var(--font-condensed)", fontSize: 10, fontWeight: 700, letterSpacing: "1.5px",
    textTransform: "uppercase", padding: "6px 12px", cursor: "pointer", borderRadius: "var(--radius-sm)",
    border: "1px solid var(--border-default)",
    backgroundColor: active ? "var(--btn-primary-bg)" : "transparent",
    color: active ? "var(--btn-primary-text)" : "var(--text-muted)",
  };
}

function actionButton(color = "var(--text-muted)", filled = false, disabled = false): React.CSSProperties {
  return {
    fontFamily: "var(--font-condensed)", fontSize: 10, fontWeight: 700, letterSpacing: "1px",
    textTransform: "uppercase", padding: "5px 10px", borderRadius: "var(--radius-sm)",
    border: `1px solid ${filled ? color : "var(--border-default)"}`,
    backgroundColor: filled ? color : "transparent", color: filled ? "#fff" : color,
    cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1,
  };
}

function badge(color: string): React.CSSProperties {
  return {
    fontFamily: "var(--font-condensed)", fontSize: 9, fontWeight: 700, letterSpacing: "1px",
    textTransform: "uppercase", padding: "1px 7px", borderRadius: "var(--radius-sm)",
    border: `1px solid ${color}`, color,
  };
}

function useNow(intervalMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p style={{ ...sectionLabel, marginBottom: 6 }}>{label}</p>
      {children}
    </div>
  );
}

// ── Create / edit form ───────────────────────────────────────────────────────

function BannerForm({
  initial,
  mode,
  started,
  busy,
  onSubmit,
  onCancel,
}: {
  initial: BannerFormState;
  mode: "create" | "edit";
  /** Already live: the start can't move, and ETA presets count from now. */
  started: boolean;
  busy: boolean;
  onSubmit: (input: BannerInput) => Promise<void>;
  onCancel?: () => void;
}) {
  const [f, setF] = useState<BannerFormState>(initial);
  const [error, setError] = useState("");
  const set = (patch: Partial<BannerFormState>) => setF((prev) => ({ ...prev, ...patch }));
  const effective = (form: BannerFormState) => (started ? { ...form, startMode: "now" as const } : form);

  // Previewed with the same component users get, as of the moment it goes live.
  const preview = useMemo<StatusBanner>(() => {
    const now = new Date();
    const placeholder = "Escribe aquí el mensaje del aviso…";
    const draft = bannerFormToInput(effective({ ...f, message: f.message.trim().length >= 5 ? f.message : placeholder }), now);
    const valid = typeof draft !== "string";
    return {
      id: "preview",
      message: valid ? draft.message ?? placeholder : f.message || placeholder,
      severity: f.severity,
      blocks_chat: f.blocksChat,
      contact: f.contact.trim() || null,
      starts_at: (valid && draft.starts_at) || now.toISOString(),
      ends_at: null,
      eta_at: valid ? draft.eta_at ?? null : null,
      updates: [],
      source: "manual",
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f, started]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const result = bannerFormToInput(effective(f), new Date());
    if (typeof result === "string") {
      setError(result);
      return;
    }
    setError("");
    if (started) delete result.starts_at;   // omitted = unchanged on PATCH
    // The ETA needs the same treatment: datetime-local has no seconds field, so
    // an ETA loaded into the form and sent back untouched would move itself up
    // to 59s earlier — on an edit that never opened the ETA picker.
    if (mode === "edit" && f.etaMode === initial.etaMode && f.etaAt === initial.etaAt
        && f.etaMinutes === initial.etaMinutes) {
      delete result.eta_at;
    }
    await onSubmit(result);
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <Field label="Mensaje">
        <textarea
          aria-label="Mensaje del aviso"
          value={f.message}
          maxLength={500}
          rows={3}
          onChange={(e) => set({ message: e.target.value })}
          placeholder="Ej.: Encontramos el error y trabajamos en ello. Mientras tanto puede comunicarse con soporte."
          style={{ ...inputStyle, resize: "vertical", lineHeight: 1.5 }}
        />
        <p style={{ ...hint, textAlign: "right" }}>{f.message.length}/500</p>
      </Field>

      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Severidad">
          <div className="flex gap-1 flex-wrap">
            {SEVERITY_CHOICES.map((s) => (
              <button
                key={s.key}
                type="button"
                aria-pressed={f.severity === s.key}
                style={chip(f.severity === s.key)}
                onClick={() => set({ severity: s.key, ...(f.blocksTouched ? {} : { blocksChat: s.key === "critical" }) })}
              >
                {s.label}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-2" style={{ marginTop: 10, fontSize: 12, color: "var(--text-secondary)", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={f.blocksChat}
              onChange={(e) => set({ blocksChat: e.target.checked, blocksTouched: true })}
            />
            Bloquear el envío de mensajes mientras esté activo
          </label>
        </Field>
        <Field label="Contacto (opcional)">
          <input
            aria-label="Contacto"
            value={f.contact}
            maxLength={120}
            onChange={(e) => set({ contact: e.target.value })}
            placeholder="Ej.: 45454545"
            style={inputStyle}
          />
          <p style={{ ...hint, marginTop: 4 }}>Un número de teléfono se muestra como enlace para llamar.</p>
        </Field>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        {!started && (
          <Field label="Publicación">
            <div className="flex gap-1 flex-wrap">
              <button type="button" aria-pressed={f.startMode === "now"} style={chip(f.startMode === "now")} onClick={() => set({ startMode: "now" })}>
                Publicar ahora
              </button>
              <button type="button" aria-pressed={f.startMode === "scheduled"} style={chip(f.startMode === "scheduled")} onClick={() => set({ startMode: "scheduled" })}>
                Programar
              </button>
            </div>
            {f.startMode === "scheduled" && (
              <input
                type="datetime-local"
                aria-label="Fecha de publicación"
                value={f.startsAt}
                onChange={(e) => set({ startsAt: e.target.value })}
                style={{ ...inputStyle, marginTop: 8 }}
              />
            )}
          </Field>
        )}

        <Field label="Tiempo estimado de solución">
          <div className="flex gap-1 flex-wrap">
            <button type="button" aria-pressed={f.etaMode === "none"} style={chip(f.etaMode === "none")} onClick={() => set({ etaMode: "none" })}>
              Sin estimado
            </button>
            {ETA_PRESETS.map((m) => {
              const active = f.etaMode === "preset" && f.etaMinutes === m;
              return (
                <button key={m} type="button" aria-pressed={active} style={chip(active)} onClick={() => set({ etaMode: "preset", etaMinutes: m })}>
                  {formatDuration(m * 60_000)}
                </button>
              );
            })}
            <button type="button" aria-pressed={f.etaMode === "custom"} style={chip(f.etaMode === "custom")} onClick={() => set({ etaMode: "custom" })}>
              Otra hora
            </button>
          </div>
          {f.etaMode === "custom" && (
            <input
              type="datetime-local"
              aria-label="Hora estimada de solución"
              value={f.etaAt}
              onChange={(e) => set({ etaAt: e.target.value })}
              style={{ ...inputStyle, marginTop: 8 }}
            />
          )}
        </Field>

        <Field label="Fin del aviso">
          <div className="flex gap-1 flex-wrap">
            <button type="button" aria-pressed={f.endMode === "open"} style={chip(f.endMode === "open")} onClick={() => set({ endMode: "open" })}>
              Hasta finalizarlo
            </button>
            <button type="button" aria-pressed={f.endMode === "scheduled"} style={chip(f.endMode === "scheduled")} onClick={() => set({ endMode: "scheduled" })}>
              Programar fin
            </button>
          </div>
          {f.endMode === "scheduled" && (
            <input
              type="datetime-local"
              aria-label="Fecha de fin"
              value={f.endsAt}
              onChange={(e) => set({ endsAt: e.target.value })}
              style={{ ...inputStyle, marginTop: 8 }}
            />
          )}
          <p style={{ ...hint, marginTop: 6 }}>
            {f.endMode === "open" ? "Sigue visible hasta que lo finalices." : "Se retira solo a esa hora."}
          </p>
        </Field>
      </div>

      <div>
        <p style={{ ...sectionLabel, marginBottom: 6 }}>Vista previa</p>
        <div style={{ border: "1px solid var(--border-default)", borderRadius: "var(--radius-sm)", overflow: "hidden" }}>
          <BannerView banner={preview} now={started ? new Date() : new Date(preview.starts_at)} />
        </div>
      </div>

      {error && (
        <p role="alert" style={{ fontSize: 12, color: "#ef4444" }}>
          {error}
        </p>
      )}

      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={busy}
          style={{
            fontFamily: "var(--font-condensed)", fontWeight: 700, fontSize: 11, letterSpacing: "1.5px",
            textTransform: "uppercase", backgroundColor: "var(--btn-primary-bg)", color: "var(--btn-primary-text)",
            border: "none", borderRadius: "var(--radius-sm)", padding: "8px 18px",
            cursor: busy ? "not-allowed" : "pointer", opacity: busy ? 0.6 : 1,
          }}
        >
          {mode === "edit" ? "Guardar cambios" : f.startMode === "scheduled" ? "Programar aviso" : "Publicar aviso"}
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel} style={actionButton()}>
            Cancelar
          </button>
        )}
      </div>
    </form>
  );
}

function UpdateComposer({
  busy,
  onSubmit,
  onCancel,
}: {
  busy: boolean;
  onSubmit: (text: string) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [text, setText] = useState("");
  const tooShort = text.trim().length < 3;
  return (
    <form
      className="space-y-2"
      style={{ marginTop: 12 }}
      onSubmit={async (e) => {
        e.preventDefault();
        if (tooShort) return;
        if (await onSubmit(text.trim())) setText("");
      }}
    >
      <textarea
        aria-label="Texto de la actualización"
        value={text}
        maxLength={500}
        rows={2}
        onChange={(e) => setText(e.target.value)}
        placeholder="Ej.: Encontramos el error y trabajamos en ello."
        style={{ ...inputStyle, resize: "vertical", lineHeight: 1.5 }}
      />
      <div className="flex gap-2">
        <button type="submit" disabled={busy || tooShort} style={actionButton("var(--nqt-blue, #0ea5e9)", true, busy || tooShort)}>
          Publicar actualización
        </button>
        <button type="button" onClick={onCancel} style={actionButton()}>
          Cancelar
        </button>
      </div>
    </form>
  );
}

// ── System checks + simulation ───────────────────────────────────────────────

function checkState(c: StatusCheck): { label: string; color: string } {
  if (c.down) return { label: "Caído", color: "var(--status-critical-accent)" };
  if (c.ok === false) return { label: "Con fallas", color: "var(--status-warning-accent)" };
  if (c.ok) return { label: "Operando", color: "#22c55e" };
  return { label: "Sin datos", color: "var(--text-faint)" };
}

function ChecksCard({ checks, now, error }: { checks: StatusChecks | null; now: Date; error: boolean }) {
  return (
    <section style={card} className="p-5 h-full">
      <p style={sectionLabel}>Estado del sistema</p>
      {!checks ? (
        <p style={{ fontSize: 12, color: error ? "#ef4444" : "var(--text-muted)", marginTop: 8 }}>
          {error ? "No se pudo cargar el estado del sistema. Reintentando..." : "Cargando..."}
        </p>
      ) : (
        <>
          <p style={{ ...hint, marginTop: 4, lineHeight: 1.5 }}>
            {checks.monitor_enabled
              ? `Revisión automática cada ${checks.interval_s} s. Tras ${checks.fail_threshold} fallas seguidas publica un aviso que bloquea el chat, y lo retira tras ${checks.ok_threshold} revisiones correctas.`
              : "El monitor automático está desactivado (STATUS_MONITOR_ENABLED)."}
          </p>
          <ul className="grid gap-2" style={{ marginTop: 12, gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))" }}>
            {checks.checks.map((c) => {
              const s = checkState(c);
              return (
                <li
                  key={c.key}
                  style={{ border: "1px solid var(--border-default)", borderLeft: `3px solid ${s.color}`, borderRadius: "var(--radius-sm)", padding: "10px 12px" }}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span style={{ fontSize: 13, fontWeight: 500, color: "var(--text-primary)" }}>{c.label}</span>
                    <span style={badge(s.color)}>{s.label}</span>
                  </div>
                  <p style={{ fontSize: 11, color: "var(--text-secondary)", fontWeight: 300, marginTop: 4, lineHeight: 1.4 }}>{c.detail}</p>
                  <p style={{ ...hint, fontSize: 10, marginTop: 2 }}>
                    {c.checked_at ? `Revisado: ${formatWhen(c.checked_at, now)}` : "Aún sin revisar"}
                    {!c.user_facing && " · solo informativo"}
                  </p>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

function rowTimes(b: AdminBanner, tab: Tab, now: Date): string {
  const parts = [`${tab === "scheduled" ? "Se publica" : "Inicio"}: ${formatWhen(b.starts_at, now)}`];
  if (b.ends_at) parts.push(`${tab === "past" && !b.ended_at ? "Terminó" : "Fin programado"}: ${formatWhen(b.ends_at, now)}`);
  if (b.ended_at) parts.push(`Finalizado: ${formatWhen(b.ended_at, now)}`);
  if (b.created_by) parts.push(b.created_by);
  return parts.join(" · ");
}

/** The moment each row is shown "as of": live now, scheduled at its start, past at its end. */
function rowNow(b: AdminBanner, tab: Tab, now: Date): Date {
  if (tab === "scheduled") return new Date(b.starts_at);
  if (tab === "past") return new Date(b.ended_at ?? b.ends_at ?? now.toISOString());
  return now;
}

export default function AvisosPage() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const { toast } = useToast();
  const { refresh: refreshPublicStatus } = useServiceStatus();
  const now = useNow();

  const [lists, setLists] = useState<BannerLists | null>(null);
  const [checks, setChecks] = useState<StatusChecks | null>(null);
  const [checksError, setChecksError] = useState(false);
  const [tab, setTab] = useState<Tab>("active");
  const [formKey, setFormKey] = useState(0);
  const [editing, setEditing] = useState<string | null>(null);
  const [composing, setComposing] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!loading && (!user || !user.is_admin)) router.push("/chat");
  }, [user, loading, router]);

  const load = useCallback(async () => {
    try {
      setLists(await getAdminBanners());
    } catch {
      toast("Error al cargar los avisos.", "error");
    }
  }, [toast]);

  const loadChecks = useCallback(async () => {
    try {
      setChecks(await getStatusChecks());
      setChecksError(false);
    } catch {
      // Keep any last-good `checks` on screen; just flag that the retry failed
      // so a first-load failure doesn't leave the card silently stuck forever.
      setChecksError(true);
    }
  }, []);

  useEffect(() => {
    if (!user?.is_admin) return;
    load();
    loadChecks();
    const t = setInterval(loadChecks, 30_000);
    return () => clearInterval(t);
  }, [user, load, loadChecks]);

  /** Every write: toast, reload the lists, and re-poll the public strip so the
   * admin sees exactly what users now see. */
  const run = async (action: () => Promise<unknown>, success: string): Promise<boolean> => {
    setBusy(true);
    try {
      await action();
      toast(success, "success");
      await load();
      refreshPublicStatus();
      return true;
    } catch (err) {
      toast(err instanceof Error ? err.message : "No se pudo completar la acción.", "error");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const create = async (input: BannerInput) => {
    const scheduled = !!input.starts_at && new Date(input.starts_at).getTime() > Date.now();
    if (await run(() => createBanner(input), scheduled ? "Aviso programado." : "Aviso publicado.")) {
      setFormKey((k) => k + 1);
      setTab(scheduled ? "scheduled" : "active");
    }
  };

  const switchTab = (next: Tab) => {
    setTab(next);
    setEditing(null);
    setComposing(null);
    setConfirming(null);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen" style={{ backgroundColor: "var(--bg-page)" }}>
        <span className="gv-label">Cargando...</span>
      </div>
    );
  }

  const rows: AdminBanner[] = lists ? lists[tab] : [];
  const activeCount = lists?.active.length ?? 0;
  const tabs: { key: Tab; label: string }[] = [
    { key: "active", label: `Activos (${activeCount})` },
    { key: "scheduled", label: `Programados (${lists?.scheduled.length ?? 0})` },
    { key: "past", label: `Historial (${lists?.past.length ?? 0})` },
  ];

  return (
    <div className="min-h-screen" style={{ backgroundColor: "var(--bg-page)" }}>
      {/* Claim the avisos count even before it loads (null): the badge then
          follows publish/end right away, and the header doesn't fetch the very
          list this page is already loading. */}
      <AdminHeader
        title="Avisos de servicio"
        subtitle="Banners para todos los usuarios cuando el servicio falla o hay mantenimiento."
        counts={{ avisos: lists ? activeCount : null }}
      />

      <div className="max-w-5xl mx-auto px-4 md:px-8 py-6 space-y-6">
        <ChecksCard checks={checks} now={now} error={checksError} />

        <section style={card} className="p-5">
          <p style={sectionLabel}>Nuevo aviso</p>
          <p style={{ ...hint, marginTop: 4, marginBottom: 14 }}>
            Se muestra a todos los usuarios —con o sin sesión— en el chat y en la pantalla de inicio de sesión.
          </p>
          <BannerForm key={formKey} initial={EMPTY_BANNER_FORM} mode="create" started={false} busy={busy} onSubmit={create} />
        </section>

        <section>
          <div className="flex gap-1 flex-wrap" style={{ marginBottom: 12 }}>
            {tabs.map((t) => (
              <button key={t.key} type="button" aria-pressed={tab === t.key} onClick={() => switchTab(t.key)} style={chip(tab === t.key)}>
                {t.label}
              </button>
            ))}
          </div>

          <div style={{ ...card, overflow: "hidden" }}>
            {!lists && <p style={{ padding: 20, fontSize: 12, color: "var(--text-muted)", fontWeight: 300 }}>Cargando...</p>}
            {lists && rows.length === 0 && (
              <p style={{ padding: "40px 20px", fontSize: 12, color: "var(--text-muted)", fontWeight: 300, textAlign: "center" }}>
                {EMPTY_TEXT[tab]}
              </p>
            )}
            {rows.map((b, i) => (
              <div
                key={b.id}
                data-testid="banner-row"
                data-banner-id={b.id}
                className="px-5 py-4"
                style={{ borderTop: i === 0 ? "none" : "1px solid var(--border-default)" }}
              >
                <div className="flex items-center gap-2 flex-wrap" style={{ marginBottom: 8 }}>
                  <span style={badge(b.source === "manual" ? "var(--text-muted)" : "var(--nqt-blue, #0ea5e9)")}>{SOURCE_LABEL[b.source] ?? b.source}</span>
                  {b.blocks_chat && <span style={badge("var(--status-critical-accent)")}>Bloquea el chat</span>}
                  <span style={hint}>{rowTimes(b, tab, now)}</span>
                </div>

                <div style={{ border: "1px solid var(--border-default)", borderRadius: "var(--radius-sm)", overflow: "hidden" }}>
                  <BannerView banner={b} now={rowNow(b, tab, now)} />
                </div>

                <div className="flex items-center gap-2 flex-wrap" style={{ marginTop: 10 }}>
                  {confirming === b.id ? (
                    <>
                      <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                        {tab === "active" ? "¿Finalizar este aviso ahora?" : "¿Eliminar este aviso? No se puede deshacer."}
                      </span>
                      <button
                        type="button"
                        disabled={busy}
                        style={actionButton("#ef4444", true, busy)}
                        onClick={async () => {
                          const ok = tab === "active"
                            ? await run(() => updateBanner(b.id, { end_now: true }), "Aviso finalizado.")
                            : await run(() => deleteBanner(b.id), "Aviso eliminado.");
                          if (ok) setConfirming(null);
                        }}
                      >
                        {tab === "active" ? "Sí, finalizar" : "Sí, eliminar"}
                      </button>
                      <button type="button" style={actionButton()} onClick={() => setConfirming(null)}>
                        Cancelar
                      </button>
                    </>
                  ) : (
                    <>
                      {tab === "active" && (
                        <button
                          type="button"
                          style={actionButton("var(--nqt-blue, #0ea5e9)")}
                          onClick={() => {
                            setComposing(composing === b.id ? null : b.id);
                            setEditing(null);
                          }}
                        >
                          Agregar actualización
                        </button>
                      )}
                      {tab !== "past" && (
                        <button
                          type="button"
                          style={actionButton()}
                          onClick={() => {
                            setEditing(editing === b.id ? null : b.id);
                            setComposing(null);
                          }}
                        >
                          Editar
                        </button>
                      )}
                      {tab === "scheduled" && (
                        <button
                          type="button"
                          disabled={busy}
                          style={actionButton("#22c55e", false, busy)}
                          onClick={() => run(() => updateBanner(b.id, { starts_at: new Date().toISOString() }), "Aviso publicado.")}
                        >
                          Publicar ahora
                        </button>
                      )}
                      <button type="button" style={actionButton("#ef4444")} onClick={() => setConfirming(b.id)}>
                        {tab === "active" ? "Finalizar ahora" : "Eliminar"}
                      </button>
                    </>
                  )}
                </div>

                {composing === b.id && (
                  <UpdateComposer
                    busy={busy}
                    onCancel={() => setComposing(null)}
                    onSubmit={async (text) => {
                      const ok = await run(() => addBannerUpdate(b.id, text), "Actualización publicada.");
                      if (ok) setComposing(null);
                      return ok;
                    }}
                  />
                )}

                {editing === b.id && (
                  <div style={{ marginTop: 16, paddingTop: 16, borderTop: "1px dashed var(--border-default)" }}>
                    <BannerForm
                      initial={bannerToForm(b)}
                      mode="edit"
                      started={tab === "active"}
                      busy={busy}
                      onCancel={() => setEditing(null)}
                      onSubmit={async (input) => {
                        if (await run(() => updateBanner(b.id, input), "Aviso actualizado.")) setEditing(null);
                      }}
                    />
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
