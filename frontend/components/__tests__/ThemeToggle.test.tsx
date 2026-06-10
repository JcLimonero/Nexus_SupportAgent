import { render, screen, fireEvent, act } from "@testing-library/react";
import { ThemeToggle } from "../ThemeToggle";

beforeEach(() => {
  document.documentElement.classList.remove("dark");
  localStorage.clear();
});

describe("ThemeToggle", () => {
  it("renders a button", () => {
    render(<ThemeToggle />);
    expect(screen.getByRole("button")).toBeInTheDocument();
  });

  it("shows moon icon (light mode) by default", () => {
    render(<ThemeToggle />);
    expect(screen.getByRole("button")).toHaveAttribute("aria-label", "Cambiar a modo oscuro");
  });

  it("shows sun icon when dark class is already set", async () => {
    document.documentElement.classList.add("dark");
    render(<ThemeToggle />);
    // useEffect fires after render — wait for state update
    expect(await screen.findByLabelText("Cambiar a modo claro")).toBeInTheDocument();
  });

  it("adds dark class and persists to localStorage when toggled from light", () => {
    render(<ThemeToggle />);
    fireEvent.click(screen.getByRole("button"));
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(localStorage.getItem("theme")).toBe("dark");
  });

  it("removes dark class and persists to localStorage when toggled from dark", async () => {
    document.documentElement.classList.add("dark");
    render(<ThemeToggle />);
    await screen.findByLabelText("Cambiar a modo claro"); // wait for effect
    fireEvent.click(screen.getByRole("button"));
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(localStorage.getItem("theme")).toBe("light");
  });
});
