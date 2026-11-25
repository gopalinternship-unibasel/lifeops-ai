import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { AuthChangeEvent, Session, User } from "@supabase/supabase-js";
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

type SessionLike = Pick<Session, "access_token" | "refresh_token" | "expires_at"> & {
  user: Pick<User, "id" | "updated_at">;
};

/**
 * The session to keep when auth reports `next` with `event`. Supabase re-reads the stored
 * session and emits SIGNED_IN with a new but identical object every time the tab becomes
 * visible again. Storing that copy gave `user` a new identity, and the profile forms, which
 * reload when the user changes, overwrote what had been typed. For those re-sends (SIGNED_IN,
 * and INITIAL_SESSION or the first getSession read) the previous object is kept while nothing
 * in it changed: same user, same update time, same tokens. Every other event (USER_UPDATED,
 * TOKEN_REFRESHED, SIGNED_OUT, ...) reports a real change, so its session is always taken, even
 * if the fields compared here happen to be equal.
 */
export function nextSession<S extends SessionLike>(prev: S | null, next: S | null, event: AuthChangeEvent): S | null {
  if (!prev || !next) return next;
  if (event !== "SIGNED_IN" && event !== "INITIAL_SESSION") return next;
  const same =
    prev.user.id === next.user.id &&
    prev.user.updated_at === next.user.updated_at &&
    prev.access_token === next.access_token &&
    prev.refresh_token === next.refresh_token &&
    prev.expires_at === next.expires_at;
  return same ? prev : next;
}

/**
 * The warning to confirm before signing out, or null when none is needed. A demo (anonymous)
 * session cannot be opened again once it is signed out: "Try the live demo" always starts a
 * new, empty one.
 */
export function signOutWarning(user: { is_anonymous?: boolean } | null): string | null {
  return user?.is_anonymous
    ? "You will not be able to come back to this demo's chats, plans and drafts. Starting the demo again opens a new, empty session."
    : null;
}

/**
 * The signed-in pages' session guard and their Sign out button, as plain functions so the order
 * of steps can be tested without a browser. The guard sends a visitor without a session to
 * /login. A deliberate sign-out ends the session too, and the guard used to answer that by
 * moving the user on to /login, over the button's own move to the landing page. So the guard
 * stays quiet once a sign-out has started, and the landing page opens when the sign-out call
 * has finished, also when it failed: auth-js removes the local session in that case as well.
 * One flow belongs to one mounted layout; a fresh layout starts with a fresh flow.
 */
export function createSignOutFlow() {
  let signingOut = false;
  return {
    /** Where the guard sends the visitor now: "/login" when the session is gone, else nowhere. */
    guardRedirect(loading: boolean, signedIn: boolean): "/login" | null {
      return !loading && !signedIn && !signingOut ? "/login" : null;
    },
    /**
     * Sign out, then go to the landing page. Never rejects: the Sign out button starts this
     * without waiting for it, so a thrown error used to end as an unhandled rejection. auth-js
     * reports a failed sign-out as a returned error, so a throw is unexpected; it is logged, and
     * the landing page still opens (it sends a visitor who is still signed in back to /app).
     */
    async signOut(signOut: () => Promise<void>, goToLanding: () => void): Promise<void> {
      signingOut = true;
      try {
        await signOut();
      } catch (error) {
        console.error("Sign-out failed:", error);
      } finally {
        goToLanding();
      }
    },
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    installAuthFetch();
    // CRITICAL: subscribe BEFORE getSession
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, s) => {
      setSession((prev) => nextSession(prev, s, event));
      setLoading(false);
    });
    supabase.auth.getSession().then(({ data: { session: s } }) => {
      // The stored session read at start-up: the same one INITIAL_SESSION reports.
      setSession((prev) => nextSession(prev, s, "INITIAL_SESSION"));
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
