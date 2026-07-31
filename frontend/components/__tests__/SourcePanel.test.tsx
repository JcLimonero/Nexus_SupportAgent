import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SourcePanel } from "../SourcePanel";
import type { PdfSource } from "../MessageBubble";

jest.mock("@/lib/api", () => ({
  getExcerpt: jest.fn(),
  getSignedMediaUrl: jest.fn(),
}));

import { getExcerpt, getSignedMediaUrl } from "@/lib/api";
const mockGetExcerpt = getExcerpt as jest.Mock;
const mockGetSignedMediaUrl = getSignedMediaUrl as jest.Mock;

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

  it("explains when the cited chunk was removed by a re-index", async () => {
    mockGetExcerpt.mockRejectedValueOnce(new Error("excerpt_not_found"));
    render(<SourcePanel source={source} onClose={jest.fn()} />);
    expect(await screen.findByText(/el documento fue re-indexado/i)).toBeInTheDocument();
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

  it("opens a document via signed URL in a new tab", async () => {
    mockGetSignedMediaUrl.mockResolvedValueOnce("http://api/api/media/stream/pdfs/manual.pdf?exp=1&sig=x");
    const openSpy = jest.spyOn(window, "open").mockImplementation(() => null);
    render(<SourcePanel source={source} onClose={jest.fn()} />);
    fireEvent.click(screen.getByText("Ver documento"));
    await waitFor(() => expect(mockGetSignedMediaUrl).toHaveBeenCalledWith("/data/pdfs/manual.pdf"));
    await waitFor(() =>
      expect(openSpy).toHaveBeenCalledWith("http://api/api/media/stream/pdfs/manual.pdf?exp=1&sig=x", "_blank", "noopener")
    );
    openSpy.mockRestore();
  });

  it("uses the signed URL directly as the video src", async () => {
    mockGetSignedMediaUrl.mockResolvedValueOnce("http://api/api/media/stream/videos/demo.mp4?exp=1&sig=x");
    const videoSource: PdfSource = {
      chunk_id: "vid-1",
      file_name: "demo.mp4",
      page_number: null,
      gcs_url: "/data/videos/demo.mp4",
      source_type: "video",
    };
    const { container } = render(<SourcePanel source={videoSource} onClose={jest.fn()} />);
    fireEvent.click(screen.getByText("Ver video"));
    await waitFor(() => {
      const video = container.querySelector("video");
      expect(video).not.toBeNull();
      expect(video!.getAttribute("src")).toBe("http://api/api/media/stream/videos/demo.mp4?exp=1&sig=x");
    });
  });
});
