import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent, type KeyboardEvent } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { GeometricBackdrop } from "@/components/GeometricBackdrop";
import { MondayMark } from "@/components/MondayMark";
import { ArrowRight, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { getErrorMessage } from "@/lib/errors";
import { profileLengthProblem, TEXT_LIMITS } from "@/lib/validation";

export const Route = createFileRoute("/onboarding/profile")({
  component: ProfileOnboarding,
});

const ROLES = ["Student", "Professional", "Founder", "Other"];

function ProfileOnboarding() {
  const { user, loading } = useAuth();
  // Keyed on the user's id, not the user object: the auth library hands over a fresh copy of
  // the same user on every return to the tab, and reloading then overwrote what was typed.
  const userId = user?.id;
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [role, setRole] = useState("Professional");
  const [goals, setGoals] = useState("");
  const [busy, setBusy] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (loading) return;
    if (!userId) { navigate({ to: "/login" }); return; }
    (async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("name, role, goals")
        .eq("id", userId)
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
  }, [userId, loading, navigate]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!user) return;
    const tooLong = profileLengthProblem({ name, role, goals });
    if (tooLong) {
      toast.error(tooLong);
      return;
    }
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

        <OnboardingProfileForm
          name={name} role={role} goals={goals}
          onNameChange={setName} onRoleChange={setRole} onGoalsChange={setGoals}
          busy={busy} onSubmit={handleSubmit}
        />
      </main>
    </div>
  );
}

/**
 * The onboarding fields. Labels are tied to their controls, the role buttons form a radio group
 * that says which role is chosen (arrow keys move the choice, as in any radio group), and
 * maxLength keeps each text within what the database accepts (TEXT_LIMITS).
 */
export function OnboardingProfileForm({
  name, role, goals, onNameChange, onRoleChange, onGoalsChange, busy, onSubmit,
}: {
  name: string;
  role: string;
  goals: string;
  onNameChange: (value: string) => void;
  onRoleChange: (value: string) => void;
  onGoalsChange: (value: string) => void;
  busy: boolean;
  onSubmit: (e: FormEvent) => void;
}) {
  // One role button is in the tab order: the chosen one, or the first if the stored role is
  // not one of the four.
  const focusIndex = Math.max(0, ROLES.indexOf(role));
  const onRoleKey = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = (index + step + ROLES.length) % ROLES.length;
    onRoleChange(ROLES[next]);
    e.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
  };

  return (
    <form onSubmit={onSubmit} className="mt-10 space-y-6">
      <Field label="What should I call you?" htmlFor="onb-name">
        <input
          id="onb-name"
          required value={name} onChange={(e) => onNameChange(e.target.value)}
          maxLength={TEXT_LIMITS.profileName}
          className="w-full rounded-md border border-input bg-card px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          placeholder="Alex"
        />
      </Field>

      <div>
        <span id="onb-role-label" className="block text-xs font-medium mb-1.5 text-foreground/80">Role</span>
        <div role="radiogroup" aria-labelledby="onb-role-label" className="grid grid-cols-2 gap-2">
          {ROLES.map((r, i) => (
            <button
              key={r} type="button" onClick={() => onRoleChange(r)}
              role="radio" aria-checked={role === r} tabIndex={i === focusIndex ? 0 : -1}
              onKeyDown={(e) => onRoleKey(e, i)}
              className={`rounded-md border px-3 py-2.5 text-sm font-medium transition ${
                role === r
                  ? "border-primary bg-gradient-brand-soft text-foreground"
                  : "border-border bg-card hover:bg-muted text-foreground/80"
              }`}
              style={role === r ? { background: "var(--gradient-brand-soft)" } : undefined}
            >{r}</button>
          ))}
        </div>
      </div>

      <Field label="Goals & current focus" htmlFor="onb-goals">
        <textarea
          id="onb-goals"
          required value={goals} onChange={(e) => onGoalsChange(e.target.value)}
          rows={4}
          maxLength={TEXT_LIMITS.profileGoals}
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
  );
}

function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: React.ReactNode }) {
  return (
    <div>
      <label htmlFor={htmlFor} className="block text-xs font-medium mb-1.5 text-foreground/80">{label}</label>
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
