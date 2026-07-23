"use client";
import { useEffect, useState } from "react";
import { Modal, Button } from "@/components/ui";
import { createEscalation } from "@/lib/api";
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

  // Reset/prefill each time the modal opens.
  useEffect(() => {
    if (open) {
      setName(defaultName ?? "");
      setContact("");
      setReason(defaultReason ?? "");
    }
  }, [open, defaultName, defaultReason]);

  const submit = async () => {
    if (contact.trim().length < 3 || sending) return;
    setSending(true);
    try {
      await createEscalation({ contact: contact.trim(), name, reason, sessionId });
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
          <Button variant="primary" size="sm" onClick={submit} disabled={sending || contact.trim().length < 3}>
            {sending ? "Enviando..." : "Enviar solicitud"}
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
      <div>
        <label style={labelStyle} htmlFor="esc-reason">¿En qué necesitas ayuda? (opcional)</label>
        <textarea id="esc-reason" style={{ ...inputStyle, resize: "none", lineHeight: 1.5 }} rows={3}
          value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000}
          onFocus={(e) => (e.target.style.borderColor = "var(--input-focus)")}
          onBlur={(e) => (e.target.style.borderColor = "var(--input-border)")} />
      </div>
    </Modal>
  );
}
