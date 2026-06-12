import { render, screen, fireEvent } from "@testing-library/react";
import { MessageBubble } from "../MessageBubble";
import type { Message, PdfSource } from "../MessageBubble";

const pdf: PdfSource = {
  chunk_id: "abc-123",
  file_name: "manual.pdf",
  page_number: 3,
  gcs_url: "/data/pdfs/manual.pdf",
};

describe("MessageBubble — user messages", () => {
  it("renders plain text content", () => {
    render(<MessageBubble message={{ role: "user", content: "Hola mundo" }} />);
    expect(screen.getByText("Hola mundo")).toBeInTheDocument();
  });

  it("does not render sources section", () => {
    render(<MessageBubble message={{ role: "user", content: "Hola" }} />);
    expect(screen.queryByText("PDF")).not.toBeInTheDocument();
  });
});

describe("MessageBubble — assistant messages", () => {
  it("renders message content", () => {
    render(<MessageBubble message={{ role: "assistant", content: "Respuesta del agente" }} />);
    expect(screen.getByText("Respuesta del agente")).toBeInTheDocument();
  });

  it("renders PDF source chip with file name and page", () => {
    const msg: Message = {
      role: "assistant",
      content: "Ver fuente",
      sources: { pdfs: [pdf], videos: [] },
    };
    render(<MessageBubble message={msg} />);
    expect(screen.getByText("PDF")).toBeInTheDocument();
    expect(screen.getByText(/manual\.pdf.*p\.3/)).toBeInTheDocument();
  });

  it("calls onOpenSource with the pdf object when chip clicked", () => {
    const onOpenSource = jest.fn();
    const msg: Message = {
      role: "assistant",
      content: "Ver fuente",
      sources: { pdfs: [pdf], videos: [] },
    };
    render(<MessageBubble message={msg} onOpenSource={onOpenSource} />);
    fireEvent.click(screen.getByText("PDF").closest("button")!);
    expect(onOpenSource).toHaveBeenCalledWith(pdf);
  });

  it("renders video source chip", () => {
    const msg: Message = {
      role: "assistant",
      content: "Ver video",
      sources: {
        pdfs: [],
        videos: [{ file_name: "intro.mp4", gcs_url: "/data/videos/intro.mp4" }],
      },
    };
    render(<MessageBubble message={msg} />);
    expect(screen.getByText("VID")).toBeInTheDocument();
    expect(screen.getByText(/intro\.mp4/)).toBeInTheDocument();
  });

  it("video chip is a button element (not an anchor)", () => {
    const msg: Message = {
      role: "assistant",
      content: "Ver video",
      sources: {
        pdfs: [],
        videos: [{ file_name: "intro.mp4", gcs_url: "/data/videos/intro.mp4" }],
      },
    };
    render(<MessageBubble message={msg} />);
    const chip = screen.getByText("VID").closest("button");
    expect(chip).not.toBeNull();
    expect(chip!.tagName).toBe("BUTTON");
  });

  it("calls onOpenVideo with the video object when chip clicked", () => {
    const onOpenVideo = jest.fn();
    const video = { file_name: "intro.mp4", gcs_url: "/data/videos/intro.mp4" };
    const msg: Message = {
      role: "assistant",
      content: "Ver video",
      sources: { pdfs: [], videos: [video] },
    };
    render(<MessageBubble message={msg} onOpenVideo={onOpenVideo} />);
    fireEvent.click(screen.getByText("VID").closest("button")!);
    expect(onOpenVideo).toHaveBeenCalledWith(video);
  });

  it("does not throw when video chip clicked without onOpenVideo", () => {
    const msg: Message = {
      role: "assistant",
      content: "Ver video",
      sources: { pdfs: [], videos: [{ file_name: "intro.mp4", gcs_url: "/data/videos/intro.mp4" }] },
    };
    expect(() => {
      render(<MessageBubble message={msg} />);
      fireEvent.click(screen.getByText("VID").closest("button")!);
    }).not.toThrow();
  });
});

describe("MessageBubble — follow-up chips", () => {
  it("does not render chips when onFollowUp is not provided", () => {
    const msg: Message = {
      role: "assistant",
      content: "Respuesta",
      follow_ups: ["¿Cómo configuro X?", "¿Qué es Y?"],
    };
    render(<MessageBubble message={msg} />);
    expect(screen.queryByText("¿Cómo configuro X?")).not.toBeInTheDocument();
  });

  it("renders chips when follow_ups and onFollowUp are both provided", () => {
    const msg: Message = {
      role: "assistant",
      content: "Respuesta",
      follow_ups: ["¿Cómo configuro X?", "¿Qué es Y?"],
    };
    render(<MessageBubble message={msg} onFollowUp={jest.fn()} />);
    expect(screen.getByText("¿Cómo configuro X?")).toBeInTheDocument();
    expect(screen.getByText("¿Qué es Y?")).toBeInTheDocument();
  });

  it("calls onFollowUp with the question text when a chip is clicked", () => {
    const onFollowUp = jest.fn();
    const msg: Message = {
      role: "assistant",
      content: "Respuesta",
      follow_ups: ["¿Cómo configuro X?"],
    };
    render(<MessageBubble message={msg} onFollowUp={onFollowUp} />);
    fireEvent.click(screen.getByText("¿Cómo configuro X?"));
    expect(onFollowUp).toHaveBeenCalledWith("¿Cómo configuro X?");
  });

  it("does not render chips for user messages even if follow_ups provided", () => {
    const msg: Message = {
      role: "user",
      content: "Pregunta",
      follow_ups: ["Chip?"],
    };
    render(<MessageBubble message={msg} onFollowUp={jest.fn()} />);
    expect(screen.queryByText("Chip?")).not.toBeInTheDocument();
  });
});
