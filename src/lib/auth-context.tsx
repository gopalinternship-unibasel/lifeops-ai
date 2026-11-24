import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { normalizeServerFnOrigin } from "@/lib/server-fn-origin";

interface AuthContextValue {
  user: User | null;
  session: Session | null;
  loading: boolean;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  session: null,
  loading: true,
  signOut: async () => {},
});

// ---------------------------------------------------------------------------
// Patch fetch ONCE so every TanStack server-fn call carries the user's
// Supabase bearer token. Without this, `requireSupabaseAuth` returns 401.
// ---------------------------------------------------------------------------
let fetchPatched = false;

/**
 * Only the app's own server functions get the token: relative URLs, the page's own origin, and in
 * the GitHub Pages build the Supabase Edge Function that runs them (VITE_SERVER_FN_ORIGIN).
 */
const serverFnOrigin = normalizeServerFnOrigin(import.meta.env.VITE_SERVER_FN_ORIGIN as string | undefined);
function isServerFnUrl(url: string): boolean {
  if (!url.includes("/_serverFn/")) return false;
  if (url.startsWith("/") && !url.startsWith("//")) return true;
  if (url.startsWith(`${window.location.origin}/`)) return true;
  return Boolean(serverFnOrigin && url.startsWith(`${serverFnOrigin}/`));
}

function installAuthFetch() {
  if (fetchPatched || typeof window === "undefined") return;
  fetchPatched = true;
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    try {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (isServerFnUrl(url)) {
        const { data } = await supabase.auth.getSession();
        const token = data.session?.access_token;
        if (token) {
          const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
          if (!headers.has("authorization")) headers.set("authorization", `Bearer ${token}`);
          return originalFetch(input, { ...init, headers });
        }
      }
    } catch {
      /* fall through to original fetch */
    }
    return originalFetch(input, init);
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    installAuthFetch();
    // CRITICAL: subscribe BEFORE getSession
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_evt, s) => {
      setSession(s);
      setLoading(false);
    });
    supabase.auth.getSession().then(({ data: { session: s } }) => {
      setSession(s);
      setLoading(false);
    });
    return () => subscription.unsubscribe();
  }, []);

  return (
    <AuthContext.Provider
      value={{
        user: session?.user ?? null,
        session,
        loading,
        signOut: async () => { await supabase.auth.signOut(); },
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
