import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { GeometricBackdrop } from "@/components/GeometricBackdrop";
import { MondayMark } from "@/components/MondayMark";
import { Stepper } from "./onboarding.profile";
import { AlertTriangle, ArrowRight, Check, FlaskConical, Loader2, Mail, Calendar, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { chooseDemoData, completeGoogleOAuth, getGoogleConnectionStatus, disconnectGoogle, getGoogleOAuthUrl } from "@/functions/google.functions";
import { getErrorMessage } from "@/lib/errors";

export const Route = createFileRoute("/onboarding/connectors")({
  component: ConnectorsOnboarding,
});

/**
 * sessionStorage key for the browser key of a Google sign-in this tab started. The server only
 * finishes a sign-in for the browser that holds this key (see src/server/google/callback.server.ts).
 */
const GOOGLE_SIGN_IN_KEY = "lifeops.googleSignInKey";

/** Google's code and state as the callback route hands them to this page, or null. */
export function googleReturnParams(search: string): { code: string; state: string } | null {
  const params = new URLSearchParams(search);
  const code = params.get("google_code");
  const state = params.get("google_state");
  return code && state ? { code, state } : null;
}

/**
 * Whether the user can go on to the workspace: Google connected, demo data chosen, or a demo
 * (anonymous) visitor, whom the workspace already treats as using the demo data.
 */
export function canEnterWorkspace(status: { connected: boolean; demoMode: boolean; isAnonymous: boolean }): boolean {
  return status.connected || status.demoMode || status.isAnonymous;
}

function saveSignInKey(key: string): boolean {
  try {
    sessionStorage.setItem(GOOGLE_SIGN_IN_KEY, key);
    return true;
  } catch {
    return false;
  }
}

/** The kept key, removed at once: a key is used for one sign-in only. "" when there is none. */
function takeSignInKey(): string {
  try {
    const key = sessionStorage.getItem(GOOGLE_SIGN_IN_KEY) ?? "";
    sessionStorage.removeItem(GOOGLE_SIGN_IN_KEY);
    return key;
  } catch {
    return "";
  }
}

function ConnectorsOnboarding() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const [connected, setConnected] = useState(false);
  const [email, setEmail] = useState<string | null>(null);
  const [demoMode, setDemoMode] = useState(false);
  const [oauthConfigured, setOauthConfigured] = useState(true);
  const [oauthTesting, setOauthTesting] = useState(false);
  const [oauthError, setOauthError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  async function refreshStatus() {
    try {
      const r = await getGoogleConnectionStatus();
      setConnected(r.connected);
      setEmail(r.email);
      setDemoMode(r.demoMode);
      setOauthConfigured(r.oauthConfigured);
      setOauthTesting(r.oauthTesting);
    } catch (error: unknown) {
      toast.error(getErrorMessage(error, "Could not check Google connection"));
    } finally {
      setHydrated(true);
    }
  }

  useEffect(() => {
    if (loading) return;
    if (!user) { navigate({ to: "/login" }); return; }
    // Back from Google (through the callback route): finish the sign-in as the signed-in user.
    const returned = googleReturnParams(window.location.search);
    if (returned) {
      // Take the code out of the address bar at once, so it is not bookmarked, shared or re-sent.
      const url = new URL(window.location.href);
      url.searchParams.delete("google_code");
      url.searchParams.delete("google_state");
      window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
      setBusy(true);
      void (async () => {
        try {
          const result = await completeGoogleOAuth({ data: { ...returned, browserKey: takeSignInKey() } });
          toast.success(result.email ? `Google account connected (${result.email})` : "Google account connected");
        } catch (error: unknown) {
          const message = getErrorMessage(error, "Could not finish connecting Google");
          setOauthError(message);
          toast.error(message);
        } finally {
          setBusy(false);
          await refreshStatus();
        }
      })();
      return;
    }
    refreshStatus();
  }, [user, loading, navigate]);

  async function startOAuth() {
    if (!user) return;
    setBusy(true);
    try {
      const { url, browserKey } = await getGoogleOAuthUrl();
      if (!saveSignInKey(browserKey)) {
        throw new Error("This browser did not let the page store the sign-in details it needs. Please allow site data for this site and try again.");
      }
      window.location.assign(url);
    } catch (error: unknown) {
      const message = getErrorMessage(error, "Could not start Google connection");
      setOauthError(message);
      toast.error(message);
      setBusy(false);
    }
  }

  async function startDemo() {
    setBusy(true);
    try {
      await chooseDemoData();
      toast.success("Using the demo inbox and calendar");
      navigate({ to: "/app" });
    } catch (error: unknown) {
      toast.error(getErrorMessage(error, "Could not switch to demo data"));
      setBusy(false);
    }
  }

  async function handleDisconnect() {
    setBusy(true);
    try { await disconnectGoogle(); await refreshStatus(); toast.success("Disconnected"); }
    catch (e: unknown) { toast.error(getErrorMessage(e, "Failed")); }
    finally { setBusy(false); }
  }

  if (loading || !hydrated) {
    return <div className="min-h-screen grid place-items-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  }

  return (
    <ConnectorsView
      connected={connected}
      email={email}
      demoMode={demoMode}
      oauthConfigured={oauthConfigured}
      oauthTesting={oauthTesting}
      oauthError={oauthError}
      busy={busy}
      isAnonymous={!!user?.is_anonymous}
      onConnect={startOAuth}
      onDisconnect={handleDisconnect}
      onUseDemo={startDemo}
      onEnter={() => navigate({ to: "/app" })}
    />
  );
}

/**
 * The page as it looks once the connection status is known. Kept apart from the data loading so
 * it can be rendered in tests with given states (tests/p3-ai-google-connectors-page.test.ts).
 */
export function ConnectorsView({
  connected,
  email,
  demoMode,
  oauthConfigured,
  oauthTesting = false,
  oauthError,
  busy,
  isAnonymous,
  onConnect,
  onDisconnect,
  onUseDemo,
  onEnter,
}: {
  connected: boolean;
  email: string | null;
  demoMode: boolean;
  oauthConfigured: boolean;
  /** Google's "Testing" status: only listed test users can connect, for 7 days at a time. */
  oauthTesting?: boolean;
  oauthError: string | null;
  busy: boolean;
  isAnonymous: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  onUseDemo: () => void;
  onEnter: () => void;
}) {
  const canEnter = canEnterWorkspace({ connected, demoMode, isAnonymous });

  return (
    <div className="relative min-h-screen overflow-hidden">
      <GeometricBackdrop variant="subtle" />
      <header className="px-8 py-6 flex items-center justify-between">
        <MondayMark />
        <Stepper step={2} />
      </header>
      <main className="px-6 py-12 max-w-2xl mx-auto">
        <div className="text-xs font-mono uppercase tracking-wider text-muted-foreground mb-3">Step 2 of 2</div>
        <h1 className="text-3xl font-semibold tracking-tight">Connect your Google account</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          One sign-in connects both Gmail and Google Calendar. MONDAY will read your inbox to extract priorities,
          propose calendar blocks (which you save), and draft email replies (which you review before sending).
        </p>

        <div className="mt-10 rounded-lg border border-border bg-card p-6">
          <div className="flex items-center gap-3 mb-4">
            <ShieldCheck className="h-5 w-5 text-emerald-600" />
            <span className="text-xs font-medium text-foreground/80">Secure OAuth — your password never touches MONDAY.</span>
          </div>

          <div className="space-y-3 mb-6">
            <ScopeRow icon={<Mail className="h-4 w-4" />} title="Read recent emails" sub="Extract tasks and decide what needs replying." />
            <ScopeRow icon={<Mail className="h-4 w-4" />} title="Draft email replies" sub="Saved as drafts in Gmail — never sent automatically." />
            <ScopeRow icon={<Calendar className="h-4 w-4" />} title="Read your calendar" sub="Know what's already scheduled today." />
            <ScopeRow icon={<Calendar className="h-4 w-4" />} title="Create calendar events" sub="Only when you click Save on a proposal." />
          </div>

          {connected ? (
            <div className="flex items-center justify-between gap-3 p-3 rounded-md bg-emerald-50 border border-emerald-200">
              <div className="flex items-center gap-2 text-sm text-emerald-900">
                <Check className="h-4 w-4" /> Connected{email ? ` as ${email}` : ""}
              </div>
              <button onClick={onDisconnect} disabled={busy}
                className="text-xs px-3 py-1.5 rounded-md border border-emerald-300 text-emerald-900 hover:bg-emerald-100 transition disabled:opacity-50">
                {busy ? "…" : "Disconnect"}
              </button>
            </div>
          ) : (
            <>
              {(!oauthConfigured || oauthError) && (
                <div role="alert" data-testid="google-not-configured"
                  className="mb-4 flex gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
                  <AlertTriangle className="h-4 w-4 shrink-0 text-amber-700" />
                  <span>
                    {oauthError ??
                      "Connecting a Google account is not available on this site yet. You can use the demo inbox and calendar below; everything else works the same."}
                  </span>
                </div>
              )}
              {oauthConfigured && !oauthError && isAnonymous && (
                <div role="note" data-testid="google-needs-account"
                  className="mb-4 flex gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
                  <AlertTriangle className="h-4 w-4 shrink-0 text-amber-700" />
                  <span>
                    A demo session cannot connect a Google account, because it is deleted after 7 days and cannot be
                    reopened. Sign out, create an account with your email on the sign-in page, and connect Google from
                    there. You can keep using the demo inbox and calendar below.
                  </span>
                </div>
              )}
              {oauthConfigured && !oauthError && oauthTesting && !isAnonymous && (
                <div role="note" data-testid="google-testing-mode"
                  className="mb-4 rounded-md border border-border bg-muted p-3 text-xs text-muted-foreground">
                  Google sign-in for this app is in Google&apos;s testing phase: only Google accounts the owner has added
                  as testers can connect. Google shows a warning screen first, and asks you to connect again after
                  7 days.
                </div>
              )}
              {/* Without an OAuth client the button could only fail; the notice above says why. */}
              <button onClick={onConnect} disabled={busy || !oauthConfigured || isAnonymous}
                className="w-full inline-flex items-center justify-center gap-2 rounded-md bg-gradient-brand px-4 py-3 text-sm font-medium text-primary-foreground shadow-elev hover:opacity-95 transition disabled:opacity-60">
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <GoogleLogo />}
                Connect Google
              </button>
            </>
          )}
        </div>

        {!connected && (
          <div className="mt-6 rounded-lg border border-border bg-card p-5">
            <div className="flex items-start gap-3">
              <FlaskConical className="h-5 w-5 text-primary shrink-0" />
              <div className="min-w-0">
                <div className="text-sm font-medium">Use demo data instead</div>
                <p className="text-xs text-muted-foreground mt-0.5">
                  A sample inbox and a demo calendar stored in your account. Saving events, approving plans and
                  saving reply drafts all work; nothing leaves MONDAY. You can connect Google later from your profile.
                </p>
              </div>
            </div>
            <button onClick={onUseDemo} disabled={busy}
              className="mt-4 w-full inline-flex items-center justify-center gap-2 rounded-md border border-border bg-background px-4 py-2.5 text-sm font-medium hover:bg-muted transition disabled:opacity-60">
              {demoMode ? "Continue with demo data" : "Use demo inbox & calendar"}
            </button>
          </div>
        )}

        <button
          disabled={!canEnter}
          onClick={onEnter}
          className="mt-8 w-full inline-flex items-center justify-center gap-2 rounded-md bg-gradient-brand px-4 py-3 text-sm font-medium text-primary-foreground shadow-elev hover:opacity-95 transition disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Enter AI Workspace <ArrowRight className="h-4 w-4" />
        </button>
        {!canEnter && (
          <p className="mt-3 text-center text-xs text-muted-foreground">Connect Google or choose demo data to continue.</p>
        )}
      </main>
    </div>
  );
}

function ScopeRow({ icon, title, sub }: { icon: React.ReactNode; title: string; sub: string }) {
  return (
    <div className="flex items-start gap-3">
      <div className="mt-0.5 h-7 w-7 rounded-md grid place-items-center text-foreground/70" style={{ background: "var(--gradient-brand-soft)" }}>
        {icon}
      </div>
      <div className="min-w-0">
        <div className="text-sm font-medium">{title}</div>
        <div className="text-xs text-muted-foreground">{sub}</div>
      </div>
    </div>
  );
}

function GoogleLogo() {
  return (
    <svg viewBox="0 0 48 48" className="h-4 w-4"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.6 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3 0 5.8 1.1 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.6-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 16 19 13 24 13c3 0 5.8 1.1 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.4 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.3 35.5 26.8 36 24 36c-5.3 0-9.7-3.4-11.3-8l-6.5 5C9.5 39.5 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.3 4.2-4.1 5.6l6.2 5.2C41 35.7 44 30.3 44 24c0-1.3-.1-2.6-.4-3.5z"/></svg>
  );
}
