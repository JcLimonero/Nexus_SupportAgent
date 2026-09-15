import { fireEvent, render, screen } from "@testing-library/react";
import { BannerView } from "../ServiceStatus";
import {
  bannerFormToInput,
  canDismiss,
  dismissKey,
  elapsedLabel,
  EMPTY_BANNER_FORM,
  etaLabel,
  formatDuration,
  fromLocalInput,
  readDismissed,
  saveDismissed,
  telHref,
  toLocalInput,
  type BannerInput,
  type StatusBanner,
} from "@/lib/status";

const NOW = new Date("2026-09-15T18:00:00Z");

const banner = (over: Partial<StatusBanner> = {}): StatusBanner => ({
  id: "b1",
  message: "Encontramos el error y trabajamos en ello",
  severity: "critical",
  blocks_chat: true,
  contact: "45454545",
  starts_at: "2026-09-15T17:35:00Z",
  ends_at: null,
  eta_at: "2026-09-15T19:00:00Z",
  updates: [],
  source: "manual",
  ...over,
});

describe("status time labels", () => {
  it("formats durations", () => {
    expect(formatDuration(25 * 60_000)).toBe("25 min");
    expect(formatDuration(60 * 60_000)).toBe("1 h");
    expect(formatDuration(125 * 60_000)).toBe("2 h 5 min");
    expect(formatDuration(26 * 3_600_000)).toBe("1 d 2 h");
  });

  it("says how long the notice has been up", () => {
    expect(elapsedLabel("2026-09-15T17:35:00Z", NOW)).toBe("Desde hace 25 min");
    expect(elapsedLabel("2026-09-15T17:59:40Z", NOW)).toBe("Desde hace un momento");
  });

  it("counts down to the ETA and admits when it has passed", () => {
    expect(etaLabel("2026-09-15T19:00:00Z", NOW)).toMatch(/^Tiempo estimado de solución: ~1 h \(/);
    expect(etaLabel("2026-09-15T17:00:00Z", NOW)).toMatch(/seguimos trabajando$/);
    expect(etaLabel(null, NOW)).toBeNull();
  });
});

describe("dismissal", () => {
  beforeEach(() => localStorage.clear());

  it("never lets users hide an outage or a chat pause", () => {
    expect(canDismiss(banner())).toBe(false);
    expect(canDismiss(banner({ severity: "warning", blocks_chat: true }))).toBe(false);
    expect(canDismiss(banner({ severity: "critical", blocks_chat: false }))).toBe(false);
    expect(canDismiss(banner({ severity: "info", blocks_chat: false }))).toBe(true);
  });

  it("brings a closed notice back when it gets news", () => {
    const b = banner({ severity: "info", blocks_chat: false });
    saveDismissed([dismissKey(b)]);
    expect(readDismissed()).toContain(dismissKey(b));
    const withNews = { ...b, updates: [{ at: "2026-09-15T17:50:00Z", text: "Ya casi" }] };
    expect(readDismissed()).not.toContain(dismissKey(withNews));
  });

  it("survives corrupt storage", () => {
    localStorage.setItem("nexus_dismissed_banners", "{nope");
    expect(readDismissed()).toEqual([]);
  });
});

describe("contact links", () => {
  it("makes phone numbers tappable and leaves anything else as text", () => {
    expect(telHref("45454545")).toBe("tel:45454545");
    expect(telHref("+52 (55) 1234-5678")).toBe("tel:+525512345678");
    expect(telHref("soporte@empresa.com")).toBeNull();
    expect(telHref("123")).toBeNull();
  });
});

describe("admin form → API body", () => {
  it("rejects a too-short message", () => {
    expect(bannerFormToInput({ ...EMPTY_BANNER_FORM, message: "hey" }, NOW)).toMatch(/al menos 5/);
  });

  it("publishes now with an ETA preset counted from now", () => {
    const input = bannerFormToInput({ ...EMPTY_BANNER_FORM, message: "Falla en facturación", etaMode: "preset", etaMinutes: 30 }, NOW);
    expect(input).toMatchObject({ starts_at: null, ends_at: null, eta_at: "2026-09-15T18:30:00.000Z", contact: null });
  });

  it("counts an ETA preset from a scheduled start", () => {
    const input = bannerFormToInput(
      { ...EMPTY_BANNER_FORM, message: "Mantenimiento nocturno", startMode: "scheduled", startsAt: toLocalInput("2026-09-16T02:00:00Z"), etaMode: "preset", etaMinutes: 60 },
      NOW,
    ) as BannerInput;
    expect(input.starts_at).toBe("2026-09-16T02:00:00.000Z");
    expect(input.eta_at).toBe("2026-09-16T03:00:00.000Z");
  });

  it("asks for the dates it needs", () => {
    expect(bannerFormToInput({ ...EMPTY_BANNER_FORM, message: "Mantenimiento", startMode: "scheduled" }, NOW)).toMatch(/publicación/);
    expect(bannerFormToInput({ ...EMPTY_BANNER_FORM, message: "Mantenimiento", endMode: "scheduled" }, NOW)).toMatch(/fin/);
    expect(bannerFormToInput({ ...EMPTY_BANNER_FORM, message: "Mantenimiento", etaMode: "custom" }, NOW)).toMatch(/estimada/);
  });

  it("round-trips datetime-local values in any time zone", () => {
    expect(fromLocalInput(toLocalInput("2026-09-15T18:07:00Z"))).toBe("2026-09-15T18:07:00.000Z");
    expect(fromLocalInput("")).toBeNull();
  });
});

describe("BannerView", () => {
  it("shows severity, elapsed time, ETA, contact and the chat pause", () => {
    render(<BannerView banner={banner()} now={NOW} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Servicio interrumpido");
    expect(screen.getByText("Desde hace 25 min")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "45454545" })).toHaveAttribute("href", "tel:45454545");
    expect(screen.getByText(/envío de mensajes está pausado/)).toBeInTheDocument();
  });

  it("shows the latest update and older ones on demand", () => {
    render(
      <BannerView
        banner={banner({
          updates: [
            { at: "2026-09-15T17:40:00Z", text: "Investigando la causa" },
            { at: "2026-09-15T17:55:00Z", text: "Encontramos el error" },
          ],
        })}
        now={NOW}
      />,
    );
    expect(screen.getByText("Encontramos el error")).toBeInTheDocument();
    expect(screen.queryByText("Investigando la causa")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Ver 1 actualización anterior" }));
    expect(screen.getByText("Investigando la causa")).toBeInTheDocument();
  });

  it("offers a close button only when given a handler", () => {
    const onDismiss = jest.fn();
    const info = banner({ severity: "info", blocks_chat: false });
    const { rerender } = render(<BannerView banner={info} now={NOW} />);
    expect(screen.queryByRole("button", { name: "Cerrar aviso" })).not.toBeInTheDocument();
    rerender(<BannerView banner={info} now={NOW} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole("button", { name: "Cerrar aviso" }));
    expect(onDismiss).toHaveBeenCalled();
  });
});
