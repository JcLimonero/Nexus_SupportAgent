import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SourcePanel } from "../SourcePanel";
import type { PdfSource } from "../MessageBubble";

jest.mock("@/lib/api", () => ({
  getExcerpt: jest.fn(),
  getDocumentBlobUrl: jest.fn(),
}));

import { getExcerpt } from "@/lib/api";
const mockGetExcerpt = getExcerpt as jest.Mock;

const source: PdfSource = {
  chunk_id: "abc-123",
  file_name: "manual.pdf",
  page_number: 5,
  gcs_url: "/data/pdfs/manual.pdf",
};

beforeEach(() => {
  mockGetExcerpt.mockResolvedValue({
    chunk_id: "abc-123",
    file_name: "manual.pdf",
    source_type: "pdf",
    page_number: 5,
    content: "Texto extraído del fragmento.",
  });
});

afterEach(() => {
  jest.clearAllMocks();
});

describe("SourcePanel", () => {
  it("renders nothing when source is null", () => {
    const { container } = render(<SourcePanel source={null} onClose={jest.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows file name in the header", async () => {
    render(<SourcePanel source={source} onClose={jest.fn()} />);
    // CSS textTransform is visual only — DOM text is the original value
    expect(screen.getByText("manual.pdf")).toBeInTheDocument();
  });

  it("shows page number", async () => {
    render(<SourcePanel source={source} onClose={jest.fn()} />);
    expect(screen.getByText("Página 5")).toBeInTheDocument();
  });

  it("fetches and displays the excerpt content", async () => {
    render(<SourcePanel source={source} onClose={jest.fn()} />);
    expect(await screen.findByText("Texto extraído del fragmento.")).toBeInTheDocument();
    expect(mockGetExcerpt).toHaveBeenCalledWith("abc-123");
  });

  it("shows error message when getExcerpt fails", async () => {
    mockGetExcerpt.mockRejectedValueOnce(new Error("Network error"));
    render(<SourcePanel source={source} onClose={jest.fn()} />);
    expect(await screen.findByText("No se pudo cargar el fragmento.")).toBeInTheDocument();
  });

  it("shows missing chunk_id message when chunk_id is absent", () => {
    const noId: PdfSource = { file_name: "old.pdf", page_number: 1, gcs_url: "/data/pdfs/old.pdf" };
    render(<SourcePanel source={noId} onClose={jest.fn()} />);
    expect(screen.getByText(/no tiene un ID registrado/i)).toBeInTheDocument();
    expect(mockGetExcerpt).not.toHaveBeenCalled();
  });

  it("calls onClose when the X button is clicked", () => {
    const onClose = jest.fn();
    render(<SourcePanel source={source} onClose={onClose} />);
    fireEvent.click(screen.getByLabelText("Cerrar panel"));
    expect(onClose).toHaveBeenCalled();
  });

  it("calls onClose when the Cerrar button is clicked", () => {
    const onClose = jest.fn();
    render(<SourcePanel source={source} onClose={onClose} />);
    fireEvent.click(screen.getByText("Cerrar"));
    expect(onClose).toHaveBeenCalled();
  });

  it("calls onClose when Escape is pressed", () => {
    const onClose = jest.fn();
    render(<SourcePanel source={source} onClose={onClose} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});
