"use client";
import { Fragment, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/AuthProvider";
import { getBearerToken } from "@/lib/auth";
import { ThemeToggle } from "@/components/ThemeToggle";
import { useToast } from "@/components/Toast";
import { ConfirmDialog } from "@/components/ui";

const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

type PendingAction = { type: "admin" | "delete"; user: User };

interface User {
  id: string;
  email: string;
  is_admin: boolean;
  is_active: boolean;
}

export default function UsersPage() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const { toast } = useToast();
  const [users, setUsers]             = useState<User[]>([]);
  const [fetching, setFetching]       = useState(true);
  const [newEmail, setNewEmail]       = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newIsAdmin, setNewIsAdmin]   = useState(false);
  const [creating, setCreating]       = useState(false);
  const [pwUserId, setPwUserId]       = useState<string | null>(null);
  const [pwValue, setPwValue]         = useState("");
  const [savingPw, setSavingPw]       = useState(false);
  const [pending, setPending]         = useState<PendingAction | null>(null);
  const [actionLoading, setActionLoading] = useState(false);

  useEffect(() => {
    if (!loading && (!user || !user.is_admin)) router.push("/chat");
  }, [user, loading, router]);

  const fetchUsers = async () => {
    try {
      const token = await getBearerToken();
      const res = await fetch(`${API}/api/users`, { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) setUsers(await res.json());
    } finally {
      setFetching(false);
    }
  };

  useEffect(() => { if (user?.is_admin) fetchUsers(); }, [user]);

  const createUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    try {
      const token = await getBearerToken();
      const res = await fetch(`${API}/api/users`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ email: newEmail, password: newPassword, is_admin: newIsAdmin }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.detail || "Error al crear usuario");
      }
      setNewEmail(""); setNewPassword(""); setNewIsAdmin(false);
      toast(`Usuario ${newEmail} creado.`, "success");
      fetchUsers();
    } catch (err: unknown) {
      toast(err instanceof Error ? err.message : "Error al crear usuario", "error");
    } finally {
      setCreating(false);
    }
  };

  const patch = async (u: User, body: Partial<Pick<User, "is_active" | "is_admin">>) => {
    const token = await getBearerToken();
    const res = await fetch(`${API}/api/users/${u.id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) { toast("Error al actualizar el usuario.", "error"); return; }
    fetchUsers();
  };

  const toggleActive = (u: User) => {
    patch(u, { is_active: !u.is_active }).then(() =>
      toast(`${u.email} ${!u.is_active ? "activado" : "desactivado"}.`, "success")
    );
  };

  const toggleAdmin = (u: User) => setPending({ type: "admin", user: u });

  const doToggleAdmin = async (u: User) => {
    await patch(u, { is_admin: !u.is_admin });
    toast(`${u.email} ${!u.is_admin ? "es ahora administrador" : "ya no es administrador"}.`, "success");
  };

  const startPw = (u: User) => { setPwUserId(u.id); setPwValue(""); };
  const cancelPw = () => { setPwUserId(null); setPwValue(""); };

  const savePassword = async (u: User) => {
    if (pwValue.trim().length < 8) { toast("La contraseña debe tener al menos 8 caracteres.", "error"); return; }
    setSavingPw(true);
    try {
      const token = await getBearerToken();
      const res = await fetch(`${API}/api/users/${u.id}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ password: pwValue }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.detail?.[0]?.msg || data.detail || "Error al cambiar la contraseña");
      }
      toast(`Contraseña de ${u.email} actualizada.`, "success");
      cancelPw();
    } catch (err: unknown) {
      toast(err instanceof Error ? err.message : "Error al cambiar la contraseña", "error");
    } finally {
      setSavingPw(false);
    }
  };

  const deleteUser = (u: User) => setPending({ type: "delete", user: u });

  const doDeleteUser = async (u: User) => {
    const token = await getBearerToken();
    const res = await fetch(`${API}/api/users/${u.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
    if (res.ok) {
      toast(`${u.email} eliminado.`, "success");
      fetchUsers();
    } else {
      toast("Error al eliminar el usuario.", "error");
    }
  };

  const runPending = async () => {
    if (!pending) return;
    setActionLoading(true);
    try {
      if (pending.type === "admin") await doToggleAdmin(pending.user);
      else await doDeleteUser(pending.user);
    } finally {
      setActionLoading(false);
      setPending(null);
    }
  };

  const inputStyle: React.CSSProperties = {
    backgroundColor: "var(--input-bg)",
    border: "1px solid var(--input-border)",
    borderRadius: "var(--radius)",
    color: "var(--text-primary)",
    padding: "8px 12px",
    fontSize: 13,
    fontWeight: 300,
    width: "100%",
    outline: "none",
  };

  if (loading || fetching) {
    return (
      <div className="flex items-center justify-center min-h-screen" style={{ backgroundColor: "var(--bg-page)" }}>
        <span className="gv-label">Cargando...</span>
      </div>
    );
  }

  return (
    <div className="min-h-screen" style={{ backgroundColor: "var(--bg-page)" }}>
      {/* Header */}
      <div
        className="px-8 py-5"
        style={{ background: "linear-gradient(135deg, #050f1a 0%, #0a2540 100%)", borderBottom: "1px solid #1e3a5f" }}
      >
        <div className="max-w-3xl mx-auto flex items-start justify-between">
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
              <div style={{ width: 3, height: 18, backgroundColor: "var(--nqt-blue, #0ea5e9)", borderRadius: 2 }} />
              <h1 style={{ fontFamily: "var(--font-condensed)", fontWeight: 700, fontSize: 22, color: "#ffffff", letterSpacing: "0.5px" }}>
                Gestión de usuarios
              </h1>
            </div>
          </div>
          <div className="flex items-center gap-3 mt-1">
            <ThemeToggle className="p-1 transition-colors" style={{ color: "#64748b", background: "none", border: "none", cursor: "pointer" } as React.CSSProperties} />
            <button
              onClick={() => router.push("/admin")}
              style={{ fontSize: 10, color: "#64748b", fontFamily: "var(--font-condensed)", fontWeight: 600, letterSpacing: "2px", textTransform: "uppercase", background: "none", border: "none", cursor: "pointer" }}
              onMouseEnter={(e) => (e.currentTarget.style.color = "#e2e8f0")}
              onMouseLeave={(e) => (e.currentTarget.style.color = "#64748b")}
            >
              ← Admin
            </button>
          </div>
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-4 md:px-8 py-8 space-y-6">

        {/* Create user */}
        <div style={{ backgroundColor: "var(--bg-surface)", border: "1px solid var(--border-default)", borderRadius: "var(--radius)" }}>
          <div className="px-5 py-4" style={{ borderBottom: "1px solid var(--border-default)", borderLeft: "3px solid var(--nqt-blue, #0ea5e9)" }}>
            <span className="gv-label">Nuevo usuario</span>
          </div>
          <div className="px-5 py-5">
            <form onSubmit={createUser} className="space-y-3">
              <div className="flex gap-3">
                <div className="flex-1">
                  <label className="gv-label block mb-1.5">Correo electrónico</label>
                  <input type="email" placeholder="usuario@empresa.com" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} required style={inputStyle}
                    onFocus={(e) => (e.target.style.borderColor = "var(--input-focus)")}
                    onBlur={(e) => (e.target.style.borderColor = "var(--input-border)")} />
                </div>
                <div className="flex-1">
                  <label className="gv-label block mb-1.5">Contraseña</label>
                  <input type="password" placeholder="Mínimo 8 caracteres" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required minLength={8} style={inputStyle}
                    onFocus={(e) => (e.target.style.borderColor = "var(--input-focus)")}
                    onBlur={(e) => (e.target.style.borderColor = "var(--input-border)")} />
                </div>
              </div>
              <div className="flex items-center justify-between">
                <label className="flex items-center gap-2 cursor-pointer" style={{ fontSize: 12, color: "var(--text-muted)", fontFamily: "var(--font-condensed)", fontWeight: 600, letterSpacing: "1px", textTransform: "uppercase" }}>
                  <input type="checkbox" checked={newIsAdmin} onChange={(e) => setNewIsAdmin(e.target.checked)} style={{ accentColor: "var(--text-primary)", width: 14, height: 14 }} />
                  Administrador
                </label>
                <button type="submit" disabled={creating} className="transition-colors disabled:opacity-40"
                  style={{ fontFamily: "var(--font-condensed)", fontWeight: 700, fontSize: 11, letterSpacing: "2px", textTransform: "uppercase", backgroundColor: "var(--btn-primary-bg)", color: "var(--btn-primary-text)", border: "none", borderRadius: "var(--radius)", padding: "8px 20px", cursor: creating ? "not-allowed" : "pointer" }}
                  onMouseEnter={(e) => { if (!creating) e.currentTarget.style.backgroundColor = "var(--btn-primary-hover)"; }}
                  onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "var(--btn-primary-bg)")}
                >
                  {creating ? "Creando..." : "Crear usuario"}
                </button>
              </div>
            </form>
          </div>
        </div>

        {/* Users table */}
        <div style={{ backgroundColor: "var(--bg-surface)", border: "1px solid var(--border-default)", borderRadius: "var(--radius)", overflow: "hidden" }}>
          <div className="px-5 py-4" style={{ borderBottom: "1px solid var(--border-default)" }}>
            <span className="gv-label">Usuarios registrados</span>
            <span style={{ marginLeft: 8, fontSize: 10, color: "var(--text-faint)", fontFamily: "var(--font-condensed)" }}>({users.length})</span>
          </div>

          <div className="overflow-x-auto">
          <table className="w-full" style={{ borderCollapse: "collapse", minWidth: 760 }}>
            <thead>
              <tr style={{ borderBottom: "2px solid var(--nqt-blue, #0ea5e9)", backgroundColor: "var(--bg-muted)" }}>
                {["Email", "Rol", "Estado", "Acciones"].map((h) => (
                  <th key={h} className="text-left px-5 py-3" style={{ fontFamily: "var(--font-condensed)", fontSize: 10, fontWeight: 600, letterSpacing: "2px", textTransform: "uppercase", color: "var(--text-muted)" }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {users.map((u, i) => (
                <Fragment key={u.id}>
                <tr style={{ borderTop: i === 0 ? "none" : `1px solid var(--border-default)` }}>
                  <td className="px-5 py-3" style={{ fontSize: 13, color: "var(--text-secondary)", fontWeight: 300 }}>{u.email}</td>
                  <td className="px-5 py-3">
                    <span style={{ fontFamily: "var(--font-condensed)", fontSize: 10, fontWeight: 600, letterSpacing: "1px", textTransform: "uppercase", padding: "2px 8px", border: "1px solid var(--border-default)", color: u.is_admin ? "var(--text-primary)" : "var(--text-muted)", backgroundColor: u.is_admin ? "var(--bg-muted)" : "transparent" }}>
                      {u.is_admin ? "Admin" : "Usuario"}
                    </span>
                  </td>
                  <td className="px-5 py-3">
                    <span style={{ fontFamily: "var(--font-condensed)", fontSize: 10, fontWeight: 600, letterSpacing: "1px", textTransform: "uppercase", padding: "2px 8px", border: `1px solid ${u.is_active ? "#4a7c4a" : "#c0392b"}`, color: u.is_active ? "#4a7c4a" : "#c0392b" }}>
                      {u.is_active ? "Activo" : "Inactivo"}
                    </span>
                  </td>
                  <td className="px-5 py-3 text-right">
                    <div className="flex items-center justify-end gap-3">
                      <button onClick={() => router.push(`/admin/conversations?user=${u.id}`)} style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: "var(--font-condensed)", fontWeight: 600, letterSpacing: "1px", textTransform: "uppercase", background: "none", border: "none", cursor: "pointer" }}
                        onMouseEnter={(e) => (e.currentTarget.style.color = "var(--nqt-blue, #0ea5e9)")}
                        onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-muted)")}>
                        Conversaciones
                      </button>
                      <button onClick={() => (pwUserId === u.id ? cancelPw() : startPw(u))} style={{ fontSize: 10, color: pwUserId === u.id ? "var(--nqt-blue, #0ea5e9)" : "var(--text-muted)", fontFamily: "var(--font-condensed)", fontWeight: 600, letterSpacing: "1px", textTransform: "uppercase", background: "none", border: "none", cursor: "pointer" }}
                        onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text-primary)")}
                        onMouseLeave={(e) => (e.currentTarget.style.color = pwUserId === u.id ? "var(--nqt-blue, #0ea5e9)" : "var(--text-muted)")}>
                        Contraseña
                      </button>
                      <button onClick={() => toggleActive(u)} style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: "var(--font-condensed)", fontWeight: 600, letterSpacing: "1px", textTransform: "uppercase", background: "none", border: "none", cursor: "pointer" }}
                        onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text-primary)")}
                        onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-muted)")}>
                        {u.is_active ? "Desactivar" : "Activar"}
                      </button>
                      <button onClick={() => toggleAdmin(u)} style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: "var(--font-condensed)", fontWeight: 600, letterSpacing: "1px", textTransform: "uppercase", background: "none", border: "none", cursor: "pointer" }}
                        onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text-primary)")}
                        onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-muted)")}>
                        {u.is_admin ? "Revocar admin" : "Hacer admin"}
                      </button>
                      <button onClick={() => deleteUser(u)} style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: "var(--font-condensed)", fontWeight: 600, letterSpacing: "1px", textTransform: "uppercase", background: "none", border: "none", cursor: "pointer" }}
                        onMouseEnter={(e) => (e.currentTarget.style.color = "#c0392b")}
                        onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-muted)")}>
                        Eliminar
                      </button>
                    </div>
                  </td>
                </tr>
                {pwUserId === u.id && (
                  <tr style={{ backgroundColor: "var(--bg-muted)" }}>
                    <td colSpan={4} className="px-5 py-3">
                      <form
                        onSubmit={(e) => { e.preventDefault(); savePassword(u); }}
                        className="flex items-center gap-3 flex-wrap"
                      >
                        <span className="gv-label" style={{ whiteSpace: "nowrap" }}>Nueva contraseña</span>
                        <input
                          type="password"
                          autoFocus
                          value={pwValue}
                          onChange={(e) => setPwValue(e.target.value)}
                          placeholder="Mínimo 8 caracteres, con número o símbolo"
                          minLength={8}
                          style={{ ...inputStyle, flex: 1, minWidth: 220, width: "auto" }}
                          onFocus={(e) => (e.target.style.borderColor = "var(--input-focus)")}
                          onBlur={(e) => (e.target.style.borderColor = "var(--input-border)")}
                        />
                        <button type="submit" disabled={savingPw}
                          style={{ fontFamily: "var(--font-condensed)", fontWeight: 700, fontSize: 11, letterSpacing: "1.5px", textTransform: "uppercase", backgroundColor: "var(--btn-primary-bg)", color: "var(--btn-primary-text)", border: "none", borderRadius: "var(--radius-sm)", padding: "7px 16px", cursor: savingPw ? "not-allowed" : "pointer", opacity: savingPw ? 0.5 : 1 }}>
                          {savingPw ? "Guardando..." : "Guardar"}
                        </button>
                        <button type="button" onClick={cancelPw}
                          style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: "var(--font-condensed)", fontWeight: 600, letterSpacing: "1px", textTransform: "uppercase", background: "none", border: "1px solid var(--border-default)", borderRadius: "var(--radius-sm)", padding: "6px 12px", cursor: "pointer" }}>
                          Cancelar
                        </button>
                      </form>
                    </td>
                  </tr>
                )}
                </Fragment>
              ))}
              {users.length === 0 && (
                <tr><td colSpan={4} className="px-5 py-10 text-center" style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 300 }}>No hay usuarios registrados.</td></tr>
              )}
            </tbody>
          </table>
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={!!pending}
        title={pending?.type === "delete" ? "Eliminar usuario" : pending?.user.is_admin ? "Revocar administrador" : "Conceder administrador"}
        message={
          pending?.type === "delete"
            ? `¿Eliminar a ${pending.user.email}? Esta acción no se puede deshacer.`
            : `¿${pending?.user.is_admin ? "Revocar" : "Conceder"} permisos de administrador a ${pending?.user.email}?`
        }
        confirmLabel={pending?.type === "delete" ? "Eliminar" : "Confirmar"}
        danger={pending?.type === "delete"}
        loading={actionLoading}
        onConfirm={runPending}
        onCancel={() => setPending(null)}
      />
    </div>
  );
}
