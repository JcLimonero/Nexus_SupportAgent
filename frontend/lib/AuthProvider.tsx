"use client";
import { createContext, useContext, useEffect, useState } from "react";
import { getLocalToken } from "./auth";

interface AuthUser {
  email: string;
  is_admin: boolean;
}

interface AuthContextType {
  user: AuthUser | null;
  loading: boolean;
  refresh: () => void;
}

const AuthContext = createContext<AuthContextType>({ user: null, loading: true, refresh: () => {} });

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = () => {
    const token = getLocalToken();
    if (token) {
      try {
        const payload = JSON.parse(atob(token.split(".")[1]));
        const expired = payload.exp && payload.exp * 1000 < Date.now();
        setUser(expired ? null : { email: payload.email, is_admin: payload.is_admin ?? false });
      } catch {
        setUser(null);
      }
    } else {
      setUser(null);
    }
    setLoading(false);
  };

  useEffect(() => {
    refresh();
  }, []);

  return <AuthContext.Provider value={{ user, loading, refresh }}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
