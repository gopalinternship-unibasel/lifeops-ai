import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { GeometricBackdrop } from "@/components/GeometricBackdrop";
import { MondayMark } from "@/components/MondayMark";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { getErrorMessage } from "@/lib/errors";
import { profileLengthProblem } from "@/lib/validation";
import { OnboardingProfileForm } from "@/components/onboarding/OnboardingProfileForm";

export const Route = createFileRoute("/onboarding/profile")({
  component: ProfileOnboarding,
});

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
