import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent, useEffect, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { GeometricBackdrop } from "@/components/GeometricBackdrop";
import { MondayMark } from "@/components/MondayMark";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { getErrorMessage } from "@/lib/errors";

export const Route = createFileRoute("/login")({
  component: LoginPage,
});

function LoginPage() {
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [emailState, setEmail] = useState("");
  const [passwordState, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const demoEnabled = import.meta.env.VITE_ENABLE_ANONYMOUS_DEMO === "true";
  // Supabase "Sign in with Google" needs the Google provider enabled in Supabase Auth.
  const googleSignInEnabled = import.meta.env.VITE_ENABLE_GOOGLE_SIGNIN === "true";
  // The public hosted demo: tell visitors where their messages go (VITE_HOSTED_DEMO=true).
  const hostedDemo = import.meta.env.VITE_HOSTED_DEMO === "true";
  // While this page drives navigation itself (sign-up → onboarding), do not also redirect
  // to /app when the new session appears; that race used to skip profile onboarding.
  const navigatingRef = useRef(false);
  // Until React has taken over the server-rendered page, a click on "Sign in" would submit the
  // plain HTML form (a GET to /login that clears the fields, with no message: QA saw this on a
  // cold dev server). The button stays disabled until then, and text typed before is kept.
  const [hydrated, setHydrated] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (emailRef.current?.value) setEmail(emailRef.current.value);
    if (passwordRef.current?.value) setPassword(passwordRef.current.value);
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!authLoading && user && !navigatingRef.current) navigate({ to: "/app" });
  }, [user, authLoading, navigate]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!hydrated) return;
    const email = emailState || emailRef.current?.value || "";
    const password = passwordState || passwordRef.current?.value || "";
    setBusy(true);
    navigatingRef.current = true;
    try {
      if (mode === "signup") {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: `${window.location.origin}/onboarding/profile` },
        });
        if (error) throw error;
        if (!data.session) {
          toast.success("Account created. Check your email to confirm your address.");
          setMode("signin");
          return;
        }
        toast.success("Account created. Continuing to setup…");
        navigate({ to: "/onboarding/profile" });
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        navigate({ to: "/app" });
      }
    } catch (err: unknown) {
      navigatingRef.current = false;
      toast.error(getErrorMessage(err, "Something went wrong"));
    } finally {
      setBusy(false);
    }
  };

  const handleDemo = async () => {
    setBusy(true);
    navigatingRef.current = true;
    try {
      const { error } = await supabase.auth.signInAnonymously({
        options: { data: { name: "Demo User" } },
      });
      if (error) throw error;
      toast.success("Welcome to the private MONDAY demo");
      navigate({ to: "/app" });
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Could not start demo"));
    } finally {
      setBusy(false);
    }
  };

  const handleGoogle = async () => {
    setBusy(true);
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: `${window.location.origin}/onboarding/profile` },
      });
      if (error) throw error;
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Google sign-in failed"));
      setBusy(false);
    }
  };

  return (
    <div className="relative min-h-screen grid md:grid-cols-2 overflow-hidden">
      {/* LEFT: brand panel */}
      <div className="relative hidden md:flex flex-col justify-between p-12 border-r border-border overflow-hidden">
        <GeometricBackdrop />
        <MondayMark size={32} />
        <div className="relative z-10 max-w-md">
          <h1 className="text-4xl font-semibold tracking-tight leading-tight">
            Reorganize your day,
            <br />
            <span className="text-gradient-brand">one conversation at a time.</span>
          </h1>
          <p className="mt-4 text-sm text-muted-foreground leading-relaxed">
            MONDAY ingests your context, ranks what matters, and writes the plan back to your calendar.
          </p>
        </div>
        <p className="text-xs text-muted-foreground">© 2026 MONDAY · LifeOps AI</p>
      </div>

      {/* RIGHT: form */}
      <div className="flex flex-col items-center justify-center px-6 py-12">
        <div className="w-full max-w-sm">
          <div className="md:hidden mb-10"><MondayMark /></div>
          <h2 className="text-2xl font-semibold tracking-tight">
            {mode === "signin" ? "Sign in to MONDAY" : "Create your account"}
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            {mode === "signin" ? "Welcome back. Pick up where you left off." : "Start running your day in under a minute."}
          </p>

          {hostedDemo && (
            <p className="mt-4 rounded-md border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
              Demo with demo data only. Your messages go to a hosted AI provider, so do not enter personal information.
            </p>
          )}

          {demoEnabled && (
            <button
              onClick={handleDemo}
              disabled={busy}
              className="mt-8 w-full inline-flex items-center justify-center gap-2 rounded-md bg-foreground px-4 py-2.5 text-sm font-medium text-background hover:opacity-90 transition disabled:opacity-60"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "▶"} Try the live demo
            </button>
          )}

          {googleSignInEnabled && (
            <button
              onClick={handleGoogle}
              disabled={busy}
              className={`${demoEnabled ? "mt-3" : "mt-8"} w-full inline-flex items-center justify-center gap-3 rounded-md border border-border bg-card px-4 py-2.5 text-sm font-medium hover:bg-muted transition disabled:opacity-60`}
            >
              <GoogleIcon /> Continue with Google
            </button>
          )}

          {(demoEnabled || googleSignInEnabled) ? (
            <div className="my-6 flex items-center gap-3 text-[11px] uppercase tracking-wider text-muted-foreground">
              <span className="h-px flex-1 bg-border" /> or <span className="h-px flex-1 bg-border" />
            </div>
          ) : (
            <div className="mt-8" />
          )}

          <form onSubmit={handleSubmit} method="post" className="space-y-4" data-hydrated={hydrated ? "true" : "false"}>
            <div>
              <label className="block text-xs font-medium mb-1.5">Email</label>
              <input
                ref={emailRef}
                type="email"
                required
                autoComplete="email"
                value={emailState}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
                placeholder="you@work.com"
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1.5">Password</label>
              <input
                ref={passwordRef}
                type="password"
                required
                minLength={6}
                autoComplete={mode === "signin" ? "current-password" : "new-password"}
                value={passwordState}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
                placeholder="••••••••"
              />
            </div>
            <button
              type="submit"
              disabled={busy || !hydrated}
              aria-busy={!hydrated}
              className="w-full inline-flex items-center justify-center gap-2 rounded-md bg-gradient-brand px-4 py-2.5 text-sm font-medium text-primary-foreground shadow-elev hover:opacity-95 transition disabled:opacity-60"
            >
              {(busy || !hydrated) && <Loader2 className="h-4 w-4 animate-spin" />}
              {mode === "signin" ? "Sign in" : "Create account"}
            </button>
          </form>

          <p className="mt-6 text-sm text-muted-foreground">
            {mode === "signin" ? "New here?" : "Already have an account?"}{" "}
            <button
              onClick={() => setMode(mode === "signin" ? "signup" : "signin")}
              className="font-medium text-foreground hover:text-primary"
            >
              {mode === "signin" ? "Create account" : "Sign in"}
            </button>
          </p>
        </div>
      </div>
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 48 48">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3c-1.6 4.7-6.1 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 16 19 13 24 13c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 10-2 13.6-5.2l-6.3-5.3c-2 1.4-4.5 2.3-7.3 2.3-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.6 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.3 4.3-4.3 5.7l6.3 5.3C41.4 35.5 44 30.2 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}
