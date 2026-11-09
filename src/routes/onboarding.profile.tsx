import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { GeometricBackdrop } from "@/components/GeometricBackdrop";
import { MondayMark } from "@/components/MondayMark";
import { ArrowRight, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { getErrorMessage } from "@/lib/errors";

export const Route = createFileRoute("/onboarding/profile")({
  component: ProfileOnboarding,
});

const ROLES = ["Student", "Professional", "Founder", "Other"];

function ProfileOnboarding() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [role, setRole] = useState("Professional");
  const [goals, setGoals] = useState("");
  const [busy, setBusy] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (loading) return;
    if (!user) { navigate({ to: "/login" }); return; }
    (async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("name, role, goals")
        .eq("id", user.id)
        .maybeSingle();
      if (error) {
        toast.error(error.message);
        setHydrated(true);
        return;
      }
      // Returning user with a complete profile — skip onboarding entirely
      if (data && data.name && data.goals) {
        navigate({ to: "/app" });
        return;
      }
      if (data) {
        setName(data.name ?? "");
        setRole(data.role ?? "Professional");
        setGoals(data.goals ?? "");
      }
      setHydrated(true);
    })();
  }, [user, loading, navigate]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setBusy(true);
    try {
      const { error } = await supabase.from("profiles").upsert({
        id: user.id, name, role, goals, updated_at: new Date().toISOString(),
      });
      if (error) throw error;
      navigate({ to: "/onboarding/connectors" });
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Could not save profile"));
    } finally {
      setBusy(false);
    }
  };

  if (loading || !hydrated) {
    return (
      <div className="min-h-screen grid place-items-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="relative min-h-screen overflow-hidden">
      <GeometricBackdrop variant="subtle" />
      <header className="px-8 py-6 flex items-center justify-between">
        <MondayMark />
        <Stepper step={1} />
      </header>
      <main className="px-6 py-12 max-w-xl mx-auto">
        <div className="text-xs font-mono uppercase tracking-wider text-muted-foreground mb-3">Step 1 of 2</div>
        <h1 className="text-3xl font-semibold tracking-tight">Tell MONDAY about you</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          This shapes how the AI prioritizes your day. You can change it later.
        </p>

        <form onSubmit={handleSubmit} className="mt-10 space-y-6">
          <Field label="What should I call you?">
            <input
              required value={name} onChange={(e) => setName(e.target.value)}
              className="w-full rounded-md border border-input bg-card px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              placeholder="Alex"
            />
          </Field>

          <Field label="Role">
            <div className="grid grid-cols-2 gap-2">
              {ROLES.map((r) => (
                <button
                  key={r} type="button" onClick={() => setRole(r)}
                  className={`rounded-md border px-3 py-2.5 text-sm font-medium transition ${
                    role === r
                      ? "border-primary bg-gradient-brand-soft text-foreground"
                      : "border-border bg-card hover:bg-muted text-foreground/80"
                  }`}
                  style={role === r ? { background: "var(--gradient-brand-soft)" } : undefined}
                >{r}</button>
              ))}
            </div>
          </Field>

          <Field label="Goals & current focus">
            <textarea
              required value={goals} onChange={(e) => setGoals(e.target.value)}
              rows={4}
              className="w-full rounded-md border border-input bg-card px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-none"
              placeholder="e.g. ship research paper, prep for interview, hit the gym 4x/week, learn Spanish"
            />
          </Field>

          <button
            type="submit" disabled={busy}
            className="w-full inline-flex items-center justify-center gap-2 rounded-md bg-gradient-brand px-4 py-3 text-sm font-medium text-primary-foreground shadow-elev hover:opacity-95 transition disabled:opacity-60"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            Continue to Connectors <ArrowRight className="h-4 w-4" />
          </button>
        </form>
      </main>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-medium mb-1.5 text-foreground/80">{label}</label>
      {children}
    </div>
  );
}

export function Stepper({ step }: { step: 1 | 2 }) {
  return (
    <div className="flex items-center gap-2 text-xs font-mono">
      <Dot active={step >= 1} />
      <span className={step === 1 ? "text-foreground font-medium" : "text-muted-foreground"}>Profile</span>
      <span className="h-px w-6 bg-border" />
      <Dot active={step >= 2} />
      <span className={step === 2 ? "text-foreground font-medium" : "text-muted-foreground"}>Connectors</span>
    </div>
  );
}
function Dot({ active }: { active: boolean }) {
  return (
    <span
      className={`h-2 w-2 rounded-full ${active ? "" : "bg-border"}`}
      style={active ? { background: "var(--gradient-brand)" } : undefined}
    />
  );
}
