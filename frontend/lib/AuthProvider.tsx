"use client";
import { createContext, useContext, useEffect, useState } from "react";
import { IS_LOCAL, getLocalToken } from "./auth";

interface AuthContextType {
  user: { email: string } | null;
  loading: boolean;
  refresh: () => void;
}

const AuthContext = createContext<AuthContextType>({ user: null, loading: true, refresh: () => {} });

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<{ email: string } | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = () => {
    if (IS_LOCAL) {
      const token = getLocalToken();
      if (token) {
        try {
          // Decode JWT payload (no verification — trusts the backend)
          const payload = JSON.parse(atob(token.split(".")[1]));
          const expired = payload.exp && payload.exp * 1000 < Date.now();
          setUser(expired ? null : { email: payload.email });
        } catch {
          setUser(null);
        }
      } else {
        setUser(null);
      }
      setLoading(false);
      return;
    }

    // Firebase path
    import("firebase/auth").then(({ onAuthStateChanged }) =>
      import("./firebase").then(({ auth }) => {
        onAuthStateChanged(auth, (u) => {
          setUser(u ? { email: u.email ?? "" } : null);
          setLoading(false);
        });
      })
    );
  };

  useEffect(() => {
    refresh();
  }, []);

  return <AuthContext.Provider value={{ user, loading, refresh }}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
