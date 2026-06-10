"use client";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";

export interface Message {
  id?: string;
  role: "user" | "assistant";
  content: string;
  sources?: {
    pdfs:   Array<{ file_name: string; page_number: number | null; gcs_url: string }>;
    videos: Array<{ file_name: string; gcs_url: string }>;
  };
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

export function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === "user";
  const hasSources =
    message.sources &&
    (message.sources.pdfs.length > 0 || message.sources.videos.length > 0);

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
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
              {message.content}
            </ReactMarkdown>
          )}
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
                style={{ fontSize: 10, fontFamily: '"Barlow Condensed", sans-serif', fontWeight: 600, letterSpacing: "1px", textTransform: "uppercase", backgroundColor: "var(--bg-muted)", color: "var(--text-muted)", border: "1px solid var(--border-default)", padding: "3px 8px", textDecoration: "none" }}
                onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = "var(--border-strong)"; e.currentTarget.style.color = "var(--text-primary)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "var(--bg-muted)"; e.currentTarget.style.color = "var(--text-muted)"; }}
              >
                <span style={{ fontSize: 9 }}>PDF</span>
                <span style={{ maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {pdf.file_name}{pdf.page_number != null ? ` · p.${pdf.page_number}` : ""}
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
                style={{ fontSize: 10, fontFamily: '"Barlow Condensed", sans-serif', fontWeight: 600, letterSpacing: "1px", textTransform: "uppercase", backgroundColor: "var(--bg-muted)", color: "var(--text-muted)", border: "1px solid var(--border-default)", padding: "3px 8px", textDecoration: "none" }}
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
