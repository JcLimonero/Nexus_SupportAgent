import { render, screen, waitFor } from "@testing-library/react";

jest.mock("next/navigation", () => ({ usePathname: jest.fn() }));
jest.mock("@/lib/api", () => ({ getEscalations: jest.fn(), getAdminBanners: jest.fn() }));
jest.mock("@/components/ThemeToggle", () => ({ ThemeToggle: () => null }));
jest.mock("@/lib/AuthProvider", () => ({ useAuth: jest.fn() }));

import { usePathname } from "next/navigation";
import { getAdminBanners, getEscalations } from "@/lib/api";
import { useAuth } from "@/lib/AuthProvider";
import { AdminHeader, isActiveSection } from "../AdminHeader";

const mockPathname = usePathname as jest.Mock;
const mockEscalations = getEscalations as jest.Mock;
const mockBanners = getAdminBanners as jest.Mock;
const mockUseAuth = useAuth as jest.Mock;

const ADMIN_USER = { user: { email: "admin@nexus.local", is_admin: true, is_anon: false }, loading: false, refresh: jest.fn() };

beforeEach(() => {
  jest.clearAllMocks();
  mockPathname.mockReturnValue("/admin");
  mockEscalations.mockResolvedValue({ new_count: 0, items: [] });
  mockBanners.mockResolvedValue({ active: [], scheduled: [], past: [] });
  mockUseAuth.mockReturnValue(ADMIN_USER);
});

describe("isActiveSection", () => {
  it("matches the overview only on /admin itself", () => {
    expect(isActiveSection("/admin", "/admin")).toBe(true);
    expect(isActiveSection("/admin/users", "/admin")).toBe(false);
  });

  it("matches a section and its sub-paths, not look-alike paths", () => {
    expect(isActiveSection("/admin/users", "/admin/users")).toBe(true);
    expect(isActiveSection("/admin/conversations/abc", "/admin/conversations")).toBe(true);
    expect(isActiveSection("/admin/usersx", "/admin/users")).toBe(false);
  });
});

describe("AdminHeader", () => {
  it("links every section and marks the current page", async () => {
    mockPathname.mockReturnValue("/admin/escalations");
    render(<AdminHeader title="Escalaciones" />);

    const nav = screen.getByRole("navigation", { name: "Secciones de administración" });
    const links = Array.from(nav.querySelectorAll("a")).map((a) => a.getAttribute("href"));
    expect(links).toEqual(["/admin", "/admin/users", "/admin/conversations", "/admin/escalations", "/admin/avisos"]);

    expect(screen.getByRole("link", { name: /Escalaciones/ })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: /Resumen/ })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("link", { name: "← Chat" })).toHaveAttribute("href", "/chat");
    await waitFor(() => expect(mockEscalations).toHaveBeenCalled());
  });

  it("shows fetched counts on their tabs", async () => {
    mockEscalations.mockResolvedValue({ new_count: 33, items: [] });
    mockBanners.mockResolvedValue({ active: [{ id: "a" }], scheduled: [], past: [] });
    render(<AdminHeader title="Panel" />);

    expect(await screen.findByText("33")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Escalaciones/ })).toHaveTextContent("33");
    expect(screen.getByRole("link", { name: /Avisos/ })).toHaveTextContent("1");
  });

  it("uses counts the page already has and skips the fetch", () => {
    render(<AdminHeader title="Panel" counts={{ escalations: 0, avisos: 2 }} />);
    expect(mockEscalations).not.toHaveBeenCalled();
    expect(mockBanners).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: /Avisos/ })).toHaveTextContent("2");
    // Zero is not worth a badge.
    expect(screen.getByRole("link", { name: /Escalaciones/ })).toHaveTextContent(/^Escalaciones$/);
  });

  it("still renders the navigation when the count requests fail", async () => {
    mockEscalations.mockRejectedValue(new Error("403"));
    mockBanners.mockRejectedValue(new Error("403"));
    render(<AdminHeader title="Panel" />);
    await waitFor(() => expect(mockBanners).toHaveBeenCalled());
    expect(screen.getAllByRole("link")).toHaveLength(7);   // logo (admin home) + 5 sections + back to chat
  });

  // Regression: /admin/avisos loads the banner list for its own table, so the
  // header asking for it again was a second call for a number the page had.
  it("never refetches a count the page claims with null while its own request is in flight (avisos page)", async () => {
    const { rerender } = render(<AdminHeader title="Avisos" counts={{ avisos: null }} />);
    await waitFor(() => expect(mockEscalations).toHaveBeenCalledTimes(1));
    expect(mockBanners).not.toHaveBeenCalled();

    // The page's own list finishes loading and supplies the real number.
    rerender(<AdminHeader title="Avisos" counts={{ avisos: 3 }} />);
    expect(mockEscalations).toHaveBeenCalledTimes(1);
    expect(mockBanners).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: /Avisos/ })).toHaveTextContent("3");
  });

  it("fetches at most once across an escalations-style reload that flickers its own count back to null", async () => {
    const { rerender } = render(<AdminHeader title="Escalaciones" counts={{ escalations: null }} />);
    await waitFor(() => expect(mockBanners).toHaveBeenCalledTimes(1));
    expect(mockEscalations).not.toHaveBeenCalled();

    // First load resolves: the page now knows its own count...
    rerender(<AdminHeader title="Escalaciones" counts={{ escalations: 5 }} />);
    // ...then the admin switches filter tabs, which re-fetches the list and
    // drops the count back to null while it's in flight.
    rerender(<AdminHeader title="Escalaciones" counts={{ escalations: null }} />);
    rerender(<AdminHeader title="Escalaciones" counts={{ escalations: 8 }} />);

    expect(mockBanners).toHaveBeenCalledTimes(1);
    expect(mockEscalations).not.toHaveBeenCalled();
  });

  it("never fetches when the page claims both counts itself (/admin)", async () => {
    render(<AdminHeader title="Panel" counts={{ escalations: null, avisos: null }} />);
    await Promise.resolve();
    expect(mockEscalations).not.toHaveBeenCalled();
    expect(mockBanners).not.toHaveBeenCalled();
  });

  // Regression: a signed-in non-admin (or guest) landing directly on an admin
  // route used to still trigger these require_admin-guarded fetches for the
  // render before the page's own redirect effect ran.
  it("never fetches admin-only counts when the signed-in user is not an admin", async () => {
    mockUseAuth.mockReturnValue({ user: { email: "user@nexus.local", is_admin: false, is_anon: false }, loading: false, refresh: jest.fn() });
    render(<AdminHeader title="Panel" />);
    await Promise.resolve();
    expect(mockEscalations).not.toHaveBeenCalled();
    expect(mockBanners).not.toHaveBeenCalled();
  });

  it("never fetches while auth is still resolving (user null, loading)", async () => {
    mockUseAuth.mockReturnValue({ user: null, loading: true, refresh: jest.fn() });
    render(<AdminHeader title="Panel" />);
    await Promise.resolve();
    expect(mockEscalations).not.toHaveBeenCalled();
    expect(mockBanners).not.toHaveBeenCalled();
  });

  it("fetches once admin status resolves after mounting with an unknown user", async () => {
    mockUseAuth.mockReturnValue({ user: null, loading: true, refresh: jest.fn() });
    const { rerender } = render(<AdminHeader title="Panel" />);
    await Promise.resolve();
    expect(mockEscalations).not.toHaveBeenCalled();

    mockUseAuth.mockReturnValue(ADMIN_USER);
    rerender(<AdminHeader title="Panel" />);
    await waitFor(() => expect(mockEscalations).toHaveBeenCalledTimes(1));
    expect(mockBanners).toHaveBeenCalledTimes(1);
  });
});
