"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/AuthProvider";
import { getBearerToken } from "@/lib/auth";
import { ThemeToggle } from "@/components/ThemeToggle";

const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

interface User {
  id: string;
  email: string;
  is_admin: boolean;
  is_active: boolean;
}

export default function UsersPage() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const [users, setUsers]         = useState<User[]>([]);
  const [fetching, setFetching]   = useState(true);
  const [newEmail, setNewEmail]   = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newIsAdmin, setNewIsAdmin]   = useState(false);
  const [creating, setCreating]   = useState(false);
  const [error, setError]         = useState("");

  useEffect(() => {
    if (!loading && (!user || !user.is_admin)) router.push("/chat");
  }, [user, loading, router]);

  const fetchUsers = async () => {
    try {
      const token = await getBearerToken();
      const res   = await fetch(`${API}/api/users`, { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) setUsers(await res.json());
    } finally {
      setFetching(false);
    }
  };

  useEffect(() => {
    if (user?.is_admin) fetchUsers();
  }, [user]);

  const createUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    setError("");
    try {
      const token = await getBearerToken();
      const res   = await fetch(`${API}/api/users`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ email: newEmail, password: newPassword, is_admin: newIsAdmin }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.detail || "Error al crear usuario");
      }
      setNewEmail(""); setNewPassword(""); setNewIsAdmin(false);
      fetchUsers();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Error");
    } finally {
      setCreating(false);
    }
  };

  const toggleActive = async (u: User) => {
    const token = await getBearerToken();
    await fetch(`${API}/api/users/${u.id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ is_active: !u.is_active }),
    });
    fetchUsers();
  };

  const deleteUser = async (u: User) => {
    if (!confirm(`¿Eliminar a ${u.email}?`)) return;
    const token = await getBearerToken();
    await fetch(`${API}/api/users/${u.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
    fetchUsers();
  };

  const inputStyle: React.CSSProperties = {
    backgroundColor: "var(--input-bg)",
    border: "1px solid var(--input-border)",
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
      <div className="px-8 py-5" style={{ backgroundColor: "var(--gv-black, #222222)", borderBottom: "1px solid #333" }}>
        <div className="max-w-3xl mx-auto flex items-start justify-between">
          <div>
            <div style={{ width: 28, height: 2, backgroundColor: "#98989A", marginBottom: 10 }} />
            <h1 style={{ fontFamily: '"Barlow Condensed", sans-serif', fontWeight: 700, fontSize: 22, color: "#ffffff", textTransform: "uppercase", letterSpacing: "0.5px" }}>
              Gestión de usuarios
            </h1>
          </div>
          <div className="flex items-center gap-3 mt-1">
            <ThemeToggle
              className="p-1 transition-colors"
              style={{ color: "#777", background: "none", border: "none", cursor: "pointer" } as React.CSSProperties}
            />
            <button
              onClick={() => router.push("/admin")}
              style={{ fontSize: 10, color: "#98989A", fontFamily: '"Barlow Condensed", sans-serif', fontWeight: 600, letterSpacing: "2px", textTransform: "uppercase", background: "none", border: "none", cursor: "pointer" }}
              onMouseEnter={(e) => (e.currentTarget.style.color = "#e8e8e8")}
              onMouseLeave={(e) => (e.currentTarget.style.color = "#98989A")}
            >
              ← Admin
            </button>
          </div>
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-4 md:px-8 py-8 space-y-6">
        {/* Create user */}
        <div style={{ backgroundColor: "var(--bg-surface)", border: "1px solid var(--border-default)" }}>
          <div className="px-5 py-4" style={{ borderBottom: "1px solid var(--border-default)", borderLeft: "3px solid var(--gv-gray-mid, #d8d8d8)" }}>
            <span className="gv-label">Nuevo usuario</span>
          </div>
          <div className="px-5 py-5">
            <form onSubmit={createUser} className="space-y-3">
              <div className="flex gap-3">
                <div className="flex-1">
                  <label className="gv-label block mb-1.5">Correo electrónico</label>
                  <input
                    type="email"
                    placeholder="usuario@empresa.com"
                    value={newEmail}
                    onChange={(e) => setNewEmail(e.target.value)}
                    required
                    style={inputStyle}
                    onFocus={(e) => (e.target.style.borderColor = "var(--input-focus)")}
                    onBlur={(e) => (e.target.style.borderColor = "var(--input-border)")}
                  />
                </div>
                <div className="flex-1">
                  <label className="gv-label block mb-1.5">Contraseña</label>
                  <input
                    type="password"
                    placeholder="Mínimo 8 caracteres"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    required
                    minLength={8}
                    style={inputStyle}
                    onFocus={(e) => (e.target.style.borderColor = "var(--input-focus)")}
                    onBlur={(e) => (e.target.style.borderColor = "var(--input-border)")}
                  />
                </div>
              </div>
              <div className="flex items-center justify-between">
                <label className="flex items-center gap-2 cursor-pointer" style={{ fontSize: 12, color: "var(--text-muted)", fontFamily: '"Barlow Condensed", sans-serif', fontWeight: 600, letterSpacing: "1px", textTransform: "uppercase" }}>
                  <input
                    type="checkbox"
                    checked={newIsAdmin}
                    onChange={(e) => setNewIsAdmin(e.target.checked)}
                    style={{ accentColor: "var(--text-primary)", width: 14, height: 14 }}
                  />
                  Administrador
                </label>
                <button
                  type="submit"
                  disabled={creating}
                  className="transition-colors disabled:opacity-40"
                  style={{
                    fontFamily: '"Barlow Condensed", sans-serif',
                    fontWeight: 700,
                    fontSize: 11,
                    letterSpacing: "2px",
                    textTransform: "uppercase",
                    backgroundColor: "var(--btn-primary-bg)",
                    color: "var(--btn-primary-text)",
                    border: "none",
                    padding: "8px 20px",
                    cursor: creating ? "not-allowed" : "pointer",
                  }}
                  onMouseEnter={(e) => { if (!creating) e.currentTarget.style.backgroundColor = "var(--btn-primary-hover)"; }}
                  onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "var(--btn-primary-bg)")}
                >
                  {creating ? "Creando..." : "Crear usuario"}
                </button>
              </div>
              {error && <p style={{ fontSize: 11, color: "#c0392b" }}>{error}</p>}
            </form>
          </div>
        </div>

        {/* Users table */}
        <div style={{ backgroundColor: "var(--bg-surface)", border: "1px solid var(--border-default)" }}>
          <div className="px-5 py-4" style={{ borderBottom: "1px solid var(--border-default)" }}>
            <span className="gv-label">Usuarios registrados</span>
            <span style={{ marginLeft: 8, fontSize: 10, color: "var(--text-faint)", fontFamily: '"Barlow Condensed", sans-serif' }}>({users.length})</span>
          </div>

          <table className="w-full" style={{ borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border-default)", backgroundColor: "var(--bg-muted)" }}>
                {["Email", "Rol", "Estado", ""].map((h) => (
                  <th
                    key={h}
                    className="text-left px-5 py-3"
                    style={{ fontFamily: '"Barlow Condensed", sans-serif', fontSize: 10, fontWeight: 600, letterSpacing: "2px", textTransform: "uppercase", color: "var(--text-muted)" }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {users.map((u, i) => (
                <tr
                  key={u.id}
                  style={{ borderTop: i === 0 ? "none" : `1px solid var(--border-default)` }}
                >
                  <td className="px-5 py-3" style={{ fontSize: 13, color: "var(--text-secondary)", fontWeight: 300 }}>
                    {u.email}
                  </td>
                  <td className="px-5 py-3">
                    <span
                      style={{
                        fontFamily: '"Barlow Condensed", sans-serif',
                        fontSize: 10,
                        fontWeight: 600,
                        letterSpacing: "1px",
                        textTransform: "uppercase",
                        padding: "2px 8px",
                        border: "1px solid var(--border-default)",
                        color: u.is_admin ? "var(--text-primary)" : "var(--text-muted)",
                        backgroundColor: u.is_admin ? "var(--bg-muted)" : "transparent",
                      }}
                    >
                      {u.is_admin ? "Admin" : "Usuario"}
                    </span>
                  </td>
                  <td className="px-5 py-3">
                    <span
                      style={{
                        fontFamily: '"Barlow Condensed", sans-serif',
                        fontSize: 10,
                        fontWeight: 600,
                        letterSpacing: "1px",
                        textTransform: "uppercase",
                        padding: "2px 8px",
                        border: `1px solid ${u.is_active ? "#4a7c4a" : "#c0392b"}`,
                        color: u.is_active ? "#4a7c4a" : "#c0392b",
                      }}
                    >
                      {u.is_active ? "Activo" : "Inactivo"}
                    </span>
                  </td>
                  <td className="px-5 py-3 text-right">
                    <div className="flex items-center justify-end gap-3">
                      <button
                        onClick={() => toggleActive(u)}
                        style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: '"Barlow Condensed", sans-serif', fontWeight: 600, letterSpacing: "1px", textTransform: "uppercase", background: "none", border: "none", cursor: "pointer" }}
                        onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text-primary)")}
                        onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-muted)")}
                      >
                        {u.is_active ? "Desactivar" : "Activar"}
                      </button>
                      <button
                        onClick={() => deleteUser(u)}
                        style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: '"Barlow Condensed", sans-serif', fontWeight: 600, letterSpacing: "1px", textTransform: "uppercase", background: "none", border: "none", cursor: "pointer" }}
                        onMouseEnter={(e) => (e.currentTarget.style.color = "#c0392b")}
                        onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-muted)")}
                      >
                        Eliminar
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {users.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-5 py-10 text-center" style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 300 }}>
                    No hay usuarios registrados.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
