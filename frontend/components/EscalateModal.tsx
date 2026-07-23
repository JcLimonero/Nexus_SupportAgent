"use client";
import { useEffect, useRef, useState } from "react";
import { Modal, Button } from "@/components/ui";
import {
  createEscalation,
  uploadEscalationAttachment,
  ATTACHMENT_ACCEPT,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_COUNT,
  type EscalationAttachment,
} from "@/lib/api";
import { useToast } from "@/components/Toast";

interface Props {
  open: boolean;
  onClose: () => void;
  sessionId: string | null;
  /** Prefills — registered user's email as name, last question as reason. */
  defaultName?: string;
  defaultReason?: string;
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  backgroundColor: "var(--input-bg)",
  border: "1px solid var(--input-border)",
  borderRadius: "var(--radius)",
  color: "var(--text-primary)",
  padding: "8px 12px",
  fontSize: 13,
  fontWeight: 300,
  outline: "none",
};

const labelStyle: React.CSSProperties = {
  fontFamily: "var(--font-condensed)",
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: "1.5px",
  textTransform: "uppercase",
  color: "var(--text-muted)",
  display: "block",
  marginBottom: 4,
};

export function EscalateModal({ open, onClose, sessionId, defaultName, defaultReason }: Props) {
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [contact, setContact] = useState("");
  const [reason, setReason] = useState("");
  const [sending, setSending] = useState(false);
  const [attachments, setAttachments] = useState<EscalationAttachment[]>([]);
  const [uploading, setUploading] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);

  // Reset/prefill each time the modal opens.
  useEffect(() => {
    if (open) {
      setName(defaultName ?? "");
      setContact("");
      setReason(defaultReason ?? "");
      setAttachments([]);
      setUploading(0);
    }
  }, [open, defaultName, defaultReason]);

  const handleFiles = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    const picked = Array.from(fileList);
    if (fileRef.current) fileRef.current.value = ""; // allow re-picking the same file
    for (const file of picked) {
      if (attachments.length >= ATTACHMENT_MAX_COUNT) {
        toast(`Máximo ${ATTACHMENT_MAX_COUNT} archivos.`, "error");
        break;
      }
      if (file.size > ATTACHMENT_MAX_BYTES) {
        toast(`"${file.name}" supera el límite de 25 MB.`, "error");
        continue;
      }
      setUploading((n) => n + 1);
      try {
        const meta = await uploadEscalationAttachment(file);
        setAttachments((prev) => [...prev, meta]);
      } catch {
        toast(`No se pudo subir "${file.name}".`, "error");
      } finally {
        setUploading((n) => n - 1);
      }
    }
  };

  const removeAttachment = (url: string) =>
    setAttachments((prev) => prev.filter((a) => a.url !== url));

  const submit = async () => {
    if (contact.trim().length < 3 || sending || uploading > 0) return;
    setSending(true);
    try {
      await createEscalation({ contact: contact.trim(), name, reason, sessionId, attachments });
      toast("Solicitud enviada. Una persona del equipo te contactará.", "success");
      onClose();
    } catch {
      toast("No se pudo enviar la solicitud. Intenta de nuevo.", "error");
    } finally {
      setSending(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Hablar con una persona"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={sending}>
            Cancelar
          </Button>
          <Button variant="primary" size="sm" onClick={submit} disabled={sending || uploading > 0 || contact.trim().length < 3}>
            {sending ? "Enviando..." : uploading > 0 ? "Subiendo..." : "Enviar solicitud"}
          </Button>
        </>
      }
    >
      <p style={{ marginBottom: 16 }}>
        Déjanos cómo contactarte y una persona del equipo de soporte te responderá.
      </p>
      <div style={{ marginBottom: 12 }}>
        <label style={labelStyle} htmlFor="esc-name">Nombre (opcional)</label>
        <input id="esc-name" style={inputStyle} value={name} onChange={(e) => setName(e.target.value)} maxLength={80}
          onFocus={(e) => (e.target.style.borderColor = "var(--input-focus)")}
          onBlur={(e) => (e.target.style.borderColor = "var(--input-border)")} />
      </div>
      <div style={{ marginBottom: 12 }}>
        <label style={labelStyle} htmlFor="esc-contact">Correo o teléfono *</label>
        <input id="esc-contact" style={inputStyle} value={contact} onChange={(e) => setContact(e.target.value)}
          placeholder="tucorreo@ejemplo.com o 55 1234 5678" maxLength={120}
          onFocus={(e) => (e.target.style.borderColor = "var(--input-focus)")}
          onBlur={(e) => (e.target.style.borderColor = "var(--input-border)")} />
      </div>
      <div style={{ marginBottom: 12 }}>
        <label style={labelStyle} htmlFor="esc-reason">¿En qué necesitas ayuda? (opcional)</label>
        <textarea id="esc-reason" style={{ ...inputStyle, resize: "none", lineHeight: 1.5 }} rows={3}
          value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000}
          onFocus={(e) => (e.target.style.borderColor = "var(--input-focus)")}
          onBlur={(e) => (e.target.style.borderColor = "var(--input-border)")} />
      </div>

      {/* Attachments — let the user recreate the problem with screenshots/video/files */}
      <div>
        <label style={labelStyle}>Adjuntos (opcional)</label>
        <input
          ref={fileRef}
          type="file"
          multiple
          accept={ATTACHMENT_ACCEPT}
          onChange={(e) => handleFiles(e.target.files)}
          style={{ display: "none" }}
          id="esc-files"
        />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={attachments.length >= ATTACHMENT_MAX_COUNT}
          style={{
            display: "flex", alignItems: "center", gap: 6,
            fontFamily: "var(--font-condensed)", fontWeight: 700, fontSize: 10,
            letterSpacing: "1.5px", textTransform: "uppercase",
            color: "var(--text-muted)", background: "none",
            border: "1px dashed var(--border-strong)", borderRadius: "var(--radius-sm)",
            padding: "7px 12px", cursor: attachments.length >= ATTACHMENT_MAX_COUNT ? "not-allowed" : "pointer",
            width: "100%", justifyContent: "center",
          }}
          onMouseEnter={(e) => { if (attachments.length < ATTACHMENT_MAX_COUNT) e.currentTarget.style.borderColor = "var(--nqt-blue, #0ea5e9)"; }}
          onMouseLeave={(e) => (e.currentTarget.style.borderColor = "var(--border-strong)")}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
          </svg>
          {uploading > 0 ? "Subiendo..." : "Adjuntar imágenes, video o archivos"}
        </button>
        <p style={{ fontSize: 10, color: "var(--text-faint)", marginTop: 4 }}>
          Imágenes, video, PDF, Word, Excel, TXT o CSV · máx. 25 MB c/u
        </p>

        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2" style={{ marginTop: 8 }}>
            {attachments.map((a) => (
              <span key={a.url} style={{
                display: "flex", alignItems: "center", gap: 6, maxWidth: "100%",
                fontSize: 11, color: "var(--text-secondary)", backgroundColor: "var(--bg-muted)",
                border: "1px solid var(--border-default)", borderRadius: "var(--radius-sm)", padding: "3px 8px",
              }}>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 180 }}>
                  {a.file_name}
                </span>
                <button type="button" onClick={() => removeAttachment(a.url)} aria-label={`Quitar ${a.file_name}`}
                  style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", lineHeight: 1, padding: 0, fontSize: 14 }}
                  onMouseEnter={(e) => (e.currentTarget.style.color = "#f87171")}
                  onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-muted)")}>
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}
