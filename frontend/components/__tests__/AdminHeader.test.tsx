import { render, screen, waitFor } from "@testing-library/react";

jest.mock("next/navigation", () => ({ usePathname: jest.fn() }));
jest.mock("@/lib/api", () => ({ getEscalations: jest.fn(), getAdminBanners: jest.fn() }));
jest.mock("@/components/ThemeToggle", () => ({ ThemeToggle: () => null }));

import { usePathname } from "next/navigation";
import { getAdminBanners, getEscalations } from "@/lib/api";
import { AdminHeader, isActiveSection } from "../AdminHeader";

const mockPathname = usePathname as jest.Mock;
const mockEscalations = getEscalations as jest.Mock;
const mockBanners = getAdminBanners as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  mockPathname.mockReturnValue("/admin");
  mockEscalations.mockResolvedValue({ new_count: 0, items: [] });
  mockBanners.mockResolvedValue({ active: [], scheduled: [], past: [] });
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
    expect(screen.getAllByRole("link")).toHaveLength(6);   // 5 sections + back to chat
  });
});
