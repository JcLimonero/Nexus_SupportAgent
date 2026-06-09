"use client";
import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/AuthProvider";
import { uploadFile, getDocuments, deleteDocument } from "@/lib/api";

interface Doc {
  file_name: string;
  source_type: "pdf" | "video";
  gcs_url: string;
}

export default function AdminPage() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const [docs, setDocs] = useState<Doc[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);

  useEffect(() => {
    if (!loading && !user) router.push("/");
    if (user) loadDocs();
  }, [user, loading]);

  const loadDocs = async () => {
    try {
      setDocs(await getDocuments());
    } catch {}
  };

  const showNotice = (text: string, ok: boolean) => {
    setNotice({ text, ok });
    setTimeout(() => setNotice(null), 4000);
  };

  const handleFiles = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      await Promise.all(Array.from(files).map((f) => uploadFile(f)));
      showNotice(
        `${files.length} archivo(s) subido(s). La indexación puede tardar unos minutos.`,
        true
      );
      setTimeout(loadDocs, 5000);
    } catch {
      showNotice("Error al subir los archivos. Verifica el formato e inténtalo de nuevo.", false);
    } finally {
      setUploading(false);
    }
  }, []);

  const handleDelete = async (fileName: string) => {
    if (!confirm(`¿Eliminar "${fileName}" del índice de búsqueda?`)) return;
    try {
      await deleteDocument(fileName);
      setDocs((prev) => prev.filter((d) => d.file_name !== fileName));
    } catch {
      showNotice("Error al eliminar el documento.", false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-50">
        <span className="text-gray-400">Cargando...</span>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 py-10 px-4">
      <div className="max-w-2xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-xl font-bold text-gray-900">Administrar documentos</h1>
            <p className="text-sm text-gray-500 mt-0.5">
              Sube PDFs y videos para que el agente los indexe y pueda responder preguntas sobre
              ellos.
            </p>
          </div>
          <button
            onClick={() => router.push("/chat")}
            className="text-sm text-blue-600 hover:underline mt-1"
          >
            ← Volver al chat
          </button>
        </div>

        {/* Notice */}
        {notice && (
          <div
            className={`px-4 py-3 rounded-lg text-sm font-medium ${
              notice.ok
                ? "bg-green-50 text-green-800 border border-green-200"
                : "bg-red-50 text-red-800 border border-red-200"
            }`}
          >
            {notice.text}
          </div>
        )}

        {/* Upload zone */}
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); handleFiles(e.dataTransfer.files); }}
          className={`border-2 border-dashed rounded-2xl p-10 text-center transition-colors ${
            dragOver ? "border-blue-500 bg-blue-50" : "border-gray-300 bg-white hover:border-gray-400"
          }`}
        >
          <input
            id="file-input"
            type="file"
            accept=".pdf,.mp4"
            multiple
            className="hidden"
            onChange={(e) => handleFiles(e.target.files)}
          />
          <label htmlFor="file-input" className="cursor-pointer block">
            <div className="text-4xl mb-3">{uploading ? "⏳" : "📁"}</div>
            <p className="text-gray-700 font-medium text-sm">
              {uploading
                ? "Subiendo archivos y lanzando indexación..."
                : "Arrastra archivos aquí o haz clic para seleccionar"}
            </p>
            <p className="text-gray-400 text-xs mt-1">Formatos: PDF, MP4</p>
          </label>
        </div>

        {/* Documents list */}
        <div className="bg-white rounded-2xl shadow-sm overflow-hidden">
          <div className="px-5 py-4 border-b flex items-center justify-between">
            <h2 className="font-semibold text-gray-800 text-sm">
              Documentos indexados
              <span className="ml-2 text-gray-400 font-normal">({docs.length})</span>
            </h2>
            <button
              onClick={loadDocs}
              className="text-xs text-gray-400 hover:text-gray-600 transition-colors"
            >
              Actualizar
            </button>
          </div>

          {docs.length === 0 ? (
            <p className="text-center text-gray-400 text-sm py-12">
              No hay documentos indexados aún. Sube un PDF o video para empezar.
            </p>
          ) : (
            <ul className="divide-y">
              {docs.map((doc) => (
                <li key={doc.file_name} className="flex items-center justify-between px-5 py-3.5">
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="text-lg shrink-0">{doc.source_type === "pdf" ? "📄" : "🎥"}</span>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-gray-800 truncate">{doc.file_name}</p>
                      <p className="text-xs text-gray-400">
                        {doc.source_type === "pdf" ? "Documento PDF" : "Video de capacitación"}
                      </p>
                    </div>
                  </div>
                  <button
                    onClick={() => handleDelete(doc.file_name)}
                    className="text-xs text-red-500 hover:text-red-700 px-3 py-1.5 hover:bg-red-50 rounded-lg transition-colors shrink-0 ml-4"
                  >
                    Eliminar
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
