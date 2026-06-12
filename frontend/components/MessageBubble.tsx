"use client";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import type { Components } from "react-markdown";

export interface PdfSource {
  chunk_id?: string;
  file_name: string;
  page_number: number | null;
  gcs_url: string;
}

export interface Message {
  id?: string;
  role: "user" | "assistant";
  content: string;
  sources?: {
    pdfs:   PdfSource[];
    videos: Array<{ file_name: string; gcs_url: string }>;
  };
  follow_ups?: string[];
  feedback?: "up" | "down";
}

const mdComponents: Components = {
  p: ({ children }) => (
    <p style={{ marginBottom: "0.65em", lineHeight: 1.7 }} className="last:mb-0">{children}</p>
  ),
  h1: ({ children }) => (
    <p style={{ fontFamily: '"Barlow Condensed", sans-serif', fontWeight: 700, fontSize: "1.15em", textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: "0.5em", color: "var(--text-primary)" }}>{children}</p>
  ),
  h2: ({ children }) => (
    <p style={{ fontFamily: '"Barlow Condensed", sans-serif', fontWeight: 700, fontSize: "1.05em", textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: "0.4em", color: "var(--text-primary)" }}>{children}</p>
  ),
  h3: ({ children }) => (
    <p style={{ fontFamily: '"Barlow Condensed", sans-serif', fontWeight: 600, fontSize: "0.95em", textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: "0.35em", color: "var(--text-primary)" }}>{children}</p>
  ),
  strong: ({ children }) => (
    <strong style={{ fontWeight: 600, color: "var(--text-primary)" }}>{children}</strong>
  ),
  em: ({ children }) => (
    <em style={{ fontStyle: "italic", color: "var(--text-secondary)" }}>{children}</em>
  ),
  ul: ({ children }) => (
    <ul style={{ paddingLeft: "1.1em", marginBottom: "0.65em", listStyleType: "none" }}>{children}</ul>
  ),
  ol: ({ children }) => (
    <ol style={{ paddingLeft: "1.5em", marginBottom: "0.65em", listStyleType: "decimal" }}>{children}</ol>
  ),
  li: ({ children }) => (
    <li style={{ marginBottom: "0.3em", paddingLeft: "0.9em", position: "relative" }}>
      <span style={{ position: "absolute", left: 0, top: "0.6em", width: 4, height: 4, borderRadius: "50%", backgroundColor: "var(--text-muted)", display: "block" }} />
      {children}
    </li>
  ),
  code: ({ children, className }) => {
    if (className?.startsWith("language-")) {
      return <code className={className}>{children}</code>;
    }
    return (
      <code style={{ fontFamily: '"Courier New", Courier, monospace', fontSize: "0.85em", backgroundColor: "var(--bg-muted)", border: "1px solid var(--border-default)", padding: "1px 5px", color: "var(--text-primary)" }}>
        {children}
      </code>
    );
  },
  pre: ({ children }) => (
    <pre style={{ backgroundColor: "var(--bg-muted)", border: "1px solid var(--border-default)", borderLeft: "3px solid var(--gv-gray-mid, #d8d8d8)", padding: "12px 14px", overflowX: "auto", marginBottom: "0.65em", fontSize: "0.82em", fontFamily: '"Courier New", Courier, monospace', lineHeight: 1.6, color: "var(--text-primary)" }}>
      {children}
    </pre>
  ),
  blockquote: ({ children }) => (
    <blockquote style={{ borderLeft: "3px solid var(--border-strong)", paddingLeft: "1em", marginLeft: 0, marginBottom: "0.65em", color: "var(--text-muted)", fontStyle: "italic" }}>
      {children}
    </blockquote>
  ),
  hr: () => (
    <hr style={{ border: "none", borderTop: "1px solid var(--border-default)", margin: "0.75em 0" }} />
  ),
  table: ({ children }) => (
    <div style={{ overflowX: "auto", marginBottom: "0.65em" }}>
      <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "0.9em" }}>{children}</table>
    </div>
  ),
  thead: ({ children }) => (
    <thead style={{ backgroundColor: "var(--bg-muted)", borderBottom: "2px solid var(--border-strong)" }}>{children}</thead>
  ),
  th: ({ children }) => (
    <th style={{ padding: "6px 12px", textAlign: "left", fontFamily: '"Barlow Condensed", sans-serif', fontSize: "0.85em", fontWeight: 600, letterSpacing: "1.5px", textTransform: "uppercase", color: "var(--text-muted)", whiteSpace: "nowrap" }}>
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td style={{ padding: "6px 12px", borderBottom: "1px solid var(--border-default)", color: "var(--text-secondary)", verticalAlign: "top" }}>
      {children}
    </td>
  ),
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: "var(--text-primary)", textDecoration: "underline", textUnderlineOffset: 2 }}>
      {children}
    </a>
  ),
};

export function MessageBubble({
  message,
  streaming = false,
  onFollowUp,
  onOpenSource,
  onOpenVideo,
  onFeedback,
  onRetry,
}: {
  message: Message;
  streaming?: boolean;
  onFollowUp?: (text: string) => void;
  onOpenSource?: (pdf: PdfSource) => void;
  onOpenVideo?: (video: { file_name: string; gcs_url: string }) => void;
  onFeedback?: (rating: "up" | "down") => void;
  onRetry?: () => void;
}) {
  const isUser = message.role === "user";
  const hasSources =
    message.sources &&
    (message.sources.pdfs.length > 0 || message.sources.videos.length > 0);
  const hasFollowUps = !isUser && message.follow_ups && message.follow_ups.length > 0 && onFollowUp;

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`flex flex-col gap-2 ${isUser ? "items-end" : "items-start"}`}
        style={{ maxWidth: "min(680px, 85%)" }}
      >
        {/* Bubble */}
        <div
          className="px-4 py-3 text-sm font-light"
          style={
            isUser
              ? { backgroundColor: "var(--bubble-user-bg)", color: "var(--bubble-user-text)", lineHeight: 1.6, whiteSpace: "pre-wrap" }
              : { backgroundColor: "var(--bubble-ai-bg)", color: "var(--bubble-ai-text)", border: "1px solid var(--bubble-ai-border)", borderLeft: "3px solid var(--gv-gray-mid, #d8d8d8)" }
          }
        >
          {isUser ? (
            message.content
          ) : (
            <>
              <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]} components={mdComponents}>
                {message.content}
              </ReactMarkdown>
              {streaming && (
                <span
                  className="animate-pulse"
                  style={{ display: "inline-block", width: 2, height: "0.85em", backgroundColor: "var(--text-muted)", marginLeft: 2, verticalAlign: "text-bottom" }}
                />
              )}
            </>
          )}
        </div>

        {/* Sources */}
        {!isUser && hasSources && (
          <div className="flex flex-wrap gap-1.5 px-1">
            {message.sources!.pdfs.map((pdf, i) => (
              <button
                key={i}
                onClick={() => onOpenSource?.(pdf)}
                className="flex items-center gap-1.5 transition-colors"
                style={{ fontSize: 10, fontFamily: '"Barlow Condensed", sans-serif', fontWeight: 600, letterSpacing: "1px", textTransform: "uppercase", backgroundColor: "var(--bg-muted)", color: "var(--text-muted)", border: "1px solid var(--border-default)", padding: "3px 8px", cursor: "pointer", background: "var(--bg-muted)" }}
                onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = "var(--border-strong)"; e.currentTarget.style.color = "var(--text-primary)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "var(--bg-muted)"; e.currentTarget.style.color = "var(--text-muted)"; }}
              >
                <span style={{ fontSize: 9 }}>PDF</span>
                <span style={{ maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {pdf.file_name}{pdf.page_number != null ? ` · p.${pdf.page_number}` : ""}
                </span>
              </button>
            ))}
            {message.sources!.videos.map((video, i) => (
              <button
                key={i}
                onClick={() => onOpenVideo?.(video)}
                className="flex items-center gap-1.5 transition-colors"
                style={{ fontSize: 10, fontFamily: '"Barlow Condensed", sans-serif', fontWeight: 600, letterSpacing: "1px", textTransform: "uppercase", backgroundColor: "var(--bg-muted)", color: "var(--text-muted)", border: "1px solid var(--border-default)", padding: "3px 8px", cursor: onOpenVideo ? "pointer" : "default" }}
                onMouseEnter={(e) => { if (onOpenVideo) { e.currentTarget.style.backgroundColor = "var(--border-strong)"; e.currentTarget.style.color = "var(--text-primary)"; } }}
                onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "var(--bg-muted)"; e.currentTarget.style.color = "var(--text-muted)"; }}
              >
                <span style={{ fontSize: 9 }}>VID</span>
                <span style={{ maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {video.file_name}
                </span>
              </button>
            ))}
          </div>
        )}

        {/* Feedback + retry row */}
        {!isUser && !streaming && (onFeedback || onRetry) && (
          <div className="flex items-center gap-1 px-1">
            {onFeedback && (
              <>
                <button
                  onClick={() => onFeedback("up")}
                  title="Respuesta útil"
                  style={{
                    background: "none",
                    border: message.feedback === "up" ? "1px solid var(--border-strong)" : "1px solid transparent",
                    cursor: "pointer",
                    padding: "3px 5px",
                    color: message.feedback === "up" ? "var(--text-primary)" : "var(--text-faint)",
                    lineHeight: 1,
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text-primary)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.color = message.feedback === "up" ? "var(--text-primary)" : "var(--text-faint)"; }}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill={message.feedback === "up" ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2">
                    <path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3H14z"/>
                    <path d="M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/>
                  </svg>
                </button>
                <button
                  onClick={() => onFeedback("down")}
                  title="Respuesta poco útil"
                  style={{
                    background: "none",
                    border: message.feedback === "down" ? "1px solid var(--border-strong)" : "1px solid transparent",
                    cursor: "pointer",
                    padding: "3px 5px",
                    color: message.feedback === "down" ? "var(--text-primary)" : "var(--text-faint)",
                    lineHeight: 1,
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text-primary)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.color = message.feedback === "down" ? "var(--text-primary)" : "var(--text-faint)"; }}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill={message.feedback === "down" ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2">
                    <path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3H10z"/>
                    <path d="M17 2h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17"/>
                  </svg>
                </button>
              </>
            )}
            {onRetry && (
              <button
                onClick={onRetry}
                title="Reintentar"
                style={{
                  background: "none",
                  border: "1px solid transparent",
                  cursor: "pointer",
                  padding: "3px 5px",
                  color: "var(--text-faint)",
                  lineHeight: 1,
                }}
                onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text-primary)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-faint)"; }}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="1 4 1 10 7 10"/>
                  <path d="M3.51 15a9 9 0 1 0 .49-3.5"/>
                </svg>
              </button>
            )}
          </div>
        )}

        {/* Follow-up suggestion chips */}
        {hasFollowUps && (
          <div className="flex flex-col gap-1.5 px-1 pt-1">
            <span style={{ fontSize: 9, fontFamily: '"Barlow Condensed", sans-serif', fontWeight: 600, letterSpacing: "2px", textTransform: "uppercase", color: "var(--text-faint)" }}>
              Preguntas relacionadas
            </span>
            <div className="flex flex-col gap-1">
              {message.follow_ups!.map((q, i) => (
                <button
                  key={i}
                  onClick={() => onFollowUp!(q)}
                  className="text-left transition-colors"
                  style={{
                    fontSize: 12,
                    fontFamily: '"Barlow", sans-serif',
                    fontWeight: 300,
                    backgroundColor: "var(--bg-muted)",
                    color: "var(--text-secondary)",
                    border: "1px solid var(--border-default)",
                    borderLeft: "2px solid var(--border-strong)",
                    padding: "6px 10px",
                    cursor: "pointer",
                    lineHeight: 1.4,
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor = "var(--bg-surface)";
                    e.currentTarget.style.color = "var(--text-primary)";
                    e.currentTarget.style.borderLeftColor = "var(--text-muted)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = "var(--bg-muted)";
                    e.currentTarget.style.color = "var(--text-secondary)";
                    e.currentTarget.style.borderLeftColor = "var(--border-strong)";
                  }}
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
