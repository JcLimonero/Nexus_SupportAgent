import { render, screen, fireEvent } from "@testing-library/react";
import { ConfirmDialog } from "../Modal";

const baseProps = {
  title: "Eliminar usuario",
  message: "¿Eliminar a juan@example.com?",
  onConfirm: jest.fn(),
  onCancel: jest.fn(),
};

afterEach(() => jest.clearAllMocks());

describe("ConfirmDialog", () => {
  it("renders nothing when closed", () => {
    const { container } = render(<ConfirmDialog open={false} {...baseProps} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders title and message when open", () => {
    render(<ConfirmDialog open {...baseProps} />);
    expect(screen.getByText("Eliminar usuario")).toBeInTheDocument();
    expect(screen.getByText("¿Eliminar a juan@example.com?")).toBeInTheDocument();
  });

  it("exposes a dialog role with aria-modal", () => {
    render(<ConfirmDialog open {...baseProps} />);
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-modal", "true");
  });

  it("calls onConfirm when the confirm button is clicked", () => {
    render(<ConfirmDialog open {...baseProps} confirmLabel="Eliminar" />);
    fireEvent.click(screen.getByText("Eliminar"));
    expect(baseProps.onConfirm).toHaveBeenCalled();
  });

  it("calls onCancel when the cancel button is clicked", () => {
    render(<ConfirmDialog open {...baseProps} />);
    fireEvent.click(screen.getByText("Cancelar"));
    expect(baseProps.onCancel).toHaveBeenCalled();
  });

  it("calls onCancel when Escape is pressed", () => {
    render(<ConfirmDialog open {...baseProps} />);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(baseProps.onCancel).toHaveBeenCalled();
  });

  it("disables both buttons while loading", () => {
    render(<ConfirmDialog open {...baseProps} loading confirmLabel="Eliminar" />);
    expect(screen.getByText("Cancelar").closest("button")).toBeDisabled();
    expect(screen.getByText("...").closest("button")).toBeDisabled();
  });
});
