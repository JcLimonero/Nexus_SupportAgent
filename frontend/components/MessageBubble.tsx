export interface Message {
  id?: string;
  role: "user" | "assistant";
  content: string;
  sources?: {
    pdfs: Array<{ file_name: string; page_number: number | null; gcs_url: string }>;
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
      <div className={`max-w-2xl flex flex-col gap-2 ${isUser ? "items-end" : "items-start"}`}>
        <div
          className={`px-4 py-3 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap ${
            isUser
              ? "bg-blue-600 text-white rounded-br-sm"
              : "bg-white text-gray-800 shadow-sm border border-gray-100 rounded-bl-sm"
          }`}
        >
          {message.content}
        </div>

        {!isUser && hasSources && (
          <div className="flex flex-wrap gap-2 px-1">
            {message.sources!.pdfs.map((pdf, i) => (
              <a
                key={i}
                href={pdf.gcs_url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 text-xs bg-amber-50 text-amber-800 border border-amber-200 px-2.5 py-1 rounded-full hover:bg-amber-100 transition-colors"
              >
                <span>📄</span>
                <span className="max-w-[180px] truncate">
                  {pdf.file_name}
                  {pdf.page_number != null ? ` — p.${pdf.page_number}` : ""}
                </span>
              </a>
            ))}
            {message.sources!.videos.map((video, i) => (
              <a
                key={i}
                href={video.gcs_url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 text-xs bg-blue-50 text-blue-800 border border-blue-200 px-2.5 py-1 rounded-full hover:bg-blue-100 transition-colors"
              >
                <span>🎥</span>
                <span className="max-w-[180px] truncate">{video.file_name}</span>
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
