"use client";
import { memo, useRef, useState } from "react";
import { IconButton } from "./ui/IconButton";
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

// Short uppercase badge derived from the file extension (PDF, DOCX, PPTX, …).
export function docLabel(fileName: string): string {
  const ext = fileName.split(".").pop()?.toUpperCase();
  return ext && ext !== fileName.toUpperCase() ? ext : "DOC";
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
  created_at?: string;
}

// Short local time stamp (HH:MM) shown under each bubble.
function fmtTime(iso?: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" });
}

// Fenced code block with a copy button (a recognized AI-chat pattern). The
// button reads the rendered text so it copies exactly what the user sees.
function CodeBlock({ children }: { children: React.ReactNode }) {
  const preRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(preRef.current?.textContent ?? "");
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch { /* clipboard unavailable */ }
  };
  return (
    <div style={{ position: "relative", marginBottom: "0.65em" }}>
      <button
        onClick={copy}
        aria-label={copied ? "Código copiado" : "Copiar código"}
        title={copied ? "Copiado" : "Copiar"}
        style={{
          position: "absolute", top: 6, right: 6, display: "flex", alignItems: "center", justifyContent: "center",
          width: 26, height: 26, background: "var(--bg-surface)", border: "1px solid var(--border-default)",
          borderRadius: "var(--radius-sm)", color: copied ? "var(--nqt-blue, #0ea5e9)" : "var(--text-muted)",
          cursor: "pointer", lineHeight: 1,
        }}
      >
        {copied ? (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12" /></svg>
        ) : (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
        )}
      </button>
      <pre ref={preRef} style={{ backgroundColor: "var(--bg-muted)", border: "1px solid var(--border-default)", borderLeft: "3px solid var(--nqt-blue, #0ea5e9)", borderRadius: "var(--radius)", padding: "12px 14px", overflowX: "auto", marginBottom: 0, fontSize: "0.82em", fontFamily: '"Courier New", Courier, monospace', lineHeight: 1.6, color: "var(--text-primary)" }}>
        {children}
      </pre>
    </div>
  );
}

const mdComponents: Components = {
  p: ({ children }) => (
    <p style={{ marginBottom: "0.65em", lineHeight: 1.7 }} className="last:mb-0">{children}</p>
  ),
  h1: ({ children }) => (
    <p style={{ fontFamily: "var(--font-condensed)", fontWeight: 700, fontSize: "1.15em", textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: "0.5em", color: "var(--text-primary)" }}>{children}</p>
  ),
  h2: ({ children }) => (
    <p style={{ fontFamily: "var(--font-condensed)", fontWeight: 700, fontSize: "1.05em", textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: "0.4em", color: "var(--text-primary)" }}>{children}</p>
  ),
  h3: ({ children }) => (
    <p style={{ fontFamily: "var(--font-condensed)", fontWeight: 600, fontSize: "0.95em", textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: "0.35em", color: "var(--text-primary)" }}>{children}</p>
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
      <span style={{ position: "absolute", left: 0, top: "0.6em", width: 4, height: 4, borderRadius: "50%", backgroundColor: "var(--nqt-blue, #0ea5e9)", display: "block" }} />
      {children}
    </li>
  ),
  code: ({ children, className }) => {
    if (className?.startsWith("language-")) {
      return <code className={className}>{children}</code>;
    }
    return (
      <code style={{ fontFamily: '"Courier New", Courier, monospace', fontSize: "0.85em", backgroundColor: "var(--bg-muted)", border: "1px solid var(--border-default)", borderRadius: "3px", padding: "1px 5px", color: "var(--nqt-cyan, #06b6d4)" }}>
        {children}
      </code>
    );
  },
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  blockquote: ({ children }) => (
    <blockquote style={{ borderLeft: "3px solid var(--nqt-blue, #0ea5e9)", paddingLeft: "1em", marginLeft: 0, marginBottom: "0.65em", color: "var(--text-muted)", fontStyle: "italic" }}>
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
    <thead style={{ backgroundColor: "var(--bg-muted)", borderBottom: "2px solid var(--nqt-blue, #0ea5e9)" }}>{children}</thead>
  ),
  th: ({ children }) => (
    <th style={{ padding: "6px 12px", textAlign: "left", fontFamily: "var(--font-condensed)", fontSize: "0.85em", fontWeight: 600, letterSpacing: "1.5px", textTransform: "uppercase", color: "var(--text-muted)", whiteSpace: "nowrap" }}>
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td style={{ padding: "6px 12px", borderBottom: "1px solid var(--border-default)", color: "var(--text-secondary)", verticalAlign: "top" }}>
      {children}
    </td>
  ),
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: "var(--nqt-blue, #0ea5e9)", textDecoration: "underline", textUnderlineOffset: 2 }}>
      {children}
    </a>
  ),
};

// Reusable markdown renderer (same styling as chat bubbles) — used by the chat
// view and the admin conversation viewer so assistant text never shows raw.
export function MarkdownContent({ children }: { children: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]} components={mdComponents}>
      {children}
    </ReactMarkdown>
  );
}

export const MessageBubble = memo(function MessageBubble({
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
  onFeedback?: (messageId: string, rating: "up" | "down") => void;
  onRetry?: () => void;
}) {
  const isUser = message.role === "user";
  const [copied, setCopied] = useState(false);
  const hasSources =
    message.sources &&
    (message.sources.pdfs.length > 0 || message.sources.videos.length > 0);
  const hasFollowUps = !isUser && message.follow_ups && message.follow_ups.length > 0 && onFollowUp;
  const timestamp = fmtTime(message.created_at);
  // Action row (copy/feedback/retry) shows on completed assistant messages.
  const showActions = !isUser && !streaming && !!message.content;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch { /* clipboard unavailable */ }
  };

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
              ? {
                  backgroundColor: "var(--bubble-user-bg)",
                  color: "var(--bubble-user-text)",
                  lineHeight: 1.6,
                  whiteSpace: "pre-wrap",
                  borderRadius: "var(--radius) var(--radius) 2px var(--radius)",
                }
              : {
                  backgroundColor: "var(--bubble-ai-bg)",
                  color: "var(--bubble-ai-text)",
                  border: "1px solid var(--bubble-ai-border)",
                  borderLeft: "3px solid var(--nqt-blue, #0ea5e9)",
                  borderRadius: "2px var(--radius) var(--radius) var(--radius)",
                }
          }
        >
          {/* Screen-reader author cue so the chat log is navigable by speaker */}
          <span className="sr-only">{isUser ? "Tú: " : "Asistente: "}</span>
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
                  style={{ display: "inline-block", width: 2, height: "0.85em", backgroundColor: "var(--nqt-blue, #0ea5e9)", marginLeft: 2, verticalAlign: "text-bottom" }}
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
                className="flex items-center gap-1.5 transition-all"
                style={{
                  fontSize: 10,
                  fontFamily: "var(--font-condensed)",
                  fontWeight: 600,
                  letterSpacing: "1px",
                  textTransform: "uppercase",
                  backgroundColor: "var(--bg-muted)",
                  color: "var(--text-muted)",
                  border: "1px solid var(--border-default)",
                  borderRadius: "var(--radius-sm)",
                  padding: "3px 8px",
                  cursor: "pointer",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = "rgba(14,165,233,0.1)";
                  e.currentTarget.style.borderColor = "var(--nqt-blue, #0ea5e9)";
                  e.currentTarget.style.color = "var(--nqt-blue, #0ea5e9)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = "var(--bg-muted)";
                  e.currentTarget.style.borderColor = "var(--border-default)";
                  e.currentTarget.style.color = "var(--text-muted)";
                }}
              >
                <span style={{ fontSize: 9 }}>{docLabel(pdf.file_name)}</span>
                <span style={{ maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {pdf.file_name}{pdf.page_number != null ? ` · p.${pdf.page_number}` : ""}
                </span>
              </button>
            ))}
            {message.sources!.videos.map((video, i) => (
              <button
                key={i}
                onClick={() => onOpenVideo?.(video)}
                className="flex items-center gap-1.5 transition-all"
                style={{
                  fontSize: 10,
                  fontFamily: "var(--font-condensed)",
                  fontWeight: 600,
                  letterSpacing: "1px",
                  textTransform: "uppercase",
                  backgroundColor: "var(--bg-muted)",
                  color: "var(--text-muted)",
                  border: "1px solid var(--border-default)",
                  borderRadius: "var(--radius-sm)",
                  padding: "3px 8px",
                  cursor: onOpenVideo ? "pointer" : "default",
                }}
                onMouseEnter={(e) => {
                  if (onOpenVideo) {
                    e.currentTarget.style.backgroundColor = "rgba(6,182,212,0.1)";
                    e.currentTarget.style.borderColor = "var(--nqt-cyan, #06b6d4)";
                    e.currentTarget.style.color = "var(--nqt-cyan, #06b6d4)";
                  }
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = "var(--bg-muted)";
                  e.currentTarget.style.borderColor = "var(--border-default)";
                  e.currentTarget.style.color = "var(--text-muted)";
                }}
              >
                <span style={{ fontSize: 9 }}>VID</span>
                <span style={{ maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {video.file_name}
                </span>
              </button>
            ))}
          </div>
        )}

        {/* Copy + feedback + retry */}
        {showActions && (
          <div className="flex items-center gap-1 px-1">
            <IconButton label={copied ? "Copiado" : "Copiar respuesta"} tone="accent" onClick={handleCopy}>
              {copied ? (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
              )}
            </IconButton>
            {onFeedback && (
              <>
                <button
                  onClick={() => message.id && onFeedback(message.id, "up")}
                  title="Respuesta útil"
                  style={{
                    background: "none",
                    border: message.feedback === "up" ? "1px solid var(--nqt-blue, #0ea5e9)" : "1px solid transparent",
                    borderRadius: "var(--radius-sm)",
                    cursor: "pointer",
                    padding: "3px 5px",
                    color: message.feedback === "up" ? "var(--nqt-blue, #0ea5e9)" : "var(--text-faint)",
                    lineHeight: 1,
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.color = "var(--nqt-blue, #0ea5e9)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.color = message.feedback === "up" ? "var(--nqt-blue, #0ea5e9)" : "var(--text-faint)"; }}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill={message.feedback === "up" ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2">
                    <path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3H14z"/>
                    <path d="M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/>
                  </svg>
                </button>
                <button
                  onClick={() => message.id && onFeedback(message.id, "down")}
                  title="Respuesta poco útil"
                  style={{
                    background: "none",
                    border: message.feedback === "down" ? "1px solid var(--text-muted)" : "1px solid transparent",
                    borderRadius: "var(--radius-sm)",
                    cursor: "pointer",
                    padding: "3px 5px",
                    color: message.feedback === "down" ? "var(--text-muted)" : "var(--text-faint)",
                    lineHeight: 1,
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.color = message.feedback === "down" ? "var(--text-muted)" : "var(--text-faint)"; }}
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
                  borderRadius: "var(--radius-sm)",
                  cursor: "pointer",
                  padding: "3px 5px",
                  color: "var(--text-faint)",
                  lineHeight: 1,
                }}
                onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}
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

        {/* Follow-ups */}
        {hasFollowUps && (
          <div className="flex flex-col gap-1.5 px-1 pt-1">
            <span style={{ fontSize: 9, fontFamily: "var(--font-condensed)", fontWeight: 600, letterSpacing: "2px", textTransform: "uppercase", color: "var(--text-faint)" }}>
              Preguntas relacionadas
            </span>
            <div className="flex flex-col gap-1">
              {message.follow_ups!.map((q, i) => (
                <button
                  key={i}
                  onClick={() => onFollowUp!(q)}
                  className="text-left transition-all"
                  style={{
                    fontSize: 12,
                    fontFamily: "var(--font-body)",
                    fontWeight: 300,
                    backgroundColor: "var(--bg-muted)",
                    color: "var(--text-secondary)",
                    border: "1px solid var(--border-default)",
                    borderLeft: "2px solid var(--nqt-blue, #0ea5e9)",
                    borderRadius: "2px var(--radius-sm) var(--radius-sm) 2px",
                    padding: "6px 10px",
                    cursor: "pointer",
                    lineHeight: 1.4,
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor = "rgba(14,165,233,0.06)";
                    e.currentTarget.style.color = "var(--text-primary)";
                    e.currentTarget.style.borderLeftColor = "var(--nqt-blue, #0ea5e9)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = "var(--bg-muted)";
                    e.currentTarget.style.color = "var(--text-secondary)";
                    e.currentTarget.style.borderLeftColor = "var(--nqt-blue, #0ea5e9)";
                  }}
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Timestamp */}
        {timestamp && !streaming && (
          <span
            className="px-1"
            style={{ fontSize: 9, fontFamily: "var(--font-condensed)", letterSpacing: "0.5px", color: "var(--text-faint)" }}
          >
            {timestamp}
          </span>
        )}
      </div>
    </div>
  );
});
