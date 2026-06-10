export interface Message {
  id?: string;
  role: "user" | "assistant";
  content: string;
  sources?: {
    pdfs:   Array<{ file_name: string; page_number: number | null; gcs_url: string }>;
    videos: Array<{ file_name: string; gcs_url: string }>;
  };
}

export function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === "user";
  const hasSources =
    message.sources &&
    (message.sources.pdfs.length > 0 || message.sources.videos.length > 0);

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div className={`flex flex-col gap-2 ${isUser ? "items-end" : "items-start"}`} style={{ maxWidth: "min(680px, 85%)" }}>

        {/* Bubble */}
        <div
          className="px-4 py-3 text-sm font-light leading-relaxed whitespace-pre-wrap"
          style={
            isUser
              ? {
                  backgroundColor: "var(--bubble-user-bg)",
                  color: "var(--bubble-user-text)",
                  borderLeft: "3px solid transparent",
                }
              : {
                  backgroundColor: "var(--bubble-ai-bg)",
                  color: "var(--bubble-ai-text)",
                  border: "1px solid var(--bubble-ai-border)",
                  borderLeft: "3px solid var(--gv-gray-mid, #d8d8d8)",
                }
          }
        >
          {message.content}
        </div>

        {/* Sources */}
        {!isUser && hasSources && (
          <div className="flex flex-wrap gap-1.5 px-1">
            {message.sources!.pdfs.map((pdf, i) => (
              <a
                key={i}
                href={pdf.gcs_url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 transition-colors"
                style={{
                  fontSize: 10,
                  fontFamily: '"Barlow Condensed", sans-serif',
                  fontWeight: 600,
                  letterSpacing: "1px",
                  textTransform: "uppercase",
                  backgroundColor: "var(--bg-muted)",
                  color: "var(--text-muted)",
                  border: "1px solid var(--border-default)",
                  padding: "3px 8px",
                  textDecoration: "none",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = "var(--border-strong)"; e.currentTarget.style.color = "var(--text-primary)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "var(--bg-muted)"; e.currentTarget.style.color = "var(--text-muted)"; }}
              >
                <span style={{ fontSize: 9 }}>PDF</span>
                <span style={{ maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {pdf.file_name}
                  {pdf.page_number != null ? ` · p.${pdf.page_number}` : ""}
                </span>
              </a>
            ))}
            {message.sources!.videos.map((video, i) => (
              <a
                key={i}
                href={video.gcs_url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 transition-colors"
                style={{
                  fontSize: 10,
                  fontFamily: '"Barlow Condensed", sans-serif',
                  fontWeight: 600,
                  letterSpacing: "1px",
                  textTransform: "uppercase",
                  backgroundColor: "var(--bg-muted)",
                  color: "var(--text-muted)",
                  border: "1px solid var(--border-default)",
                  padding: "3px 8px",
                  textDecoration: "none",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = "var(--border-strong)"; e.currentTarget.style.color = "var(--text-primary)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "var(--bg-muted)"; e.currentTarget.style.color = "var(--text-muted)"; }}
              >
                <span style={{ fontSize: 9 }}>VID</span>
                <span style={{ maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {video.file_name}
                </span>
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
