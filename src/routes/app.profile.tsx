import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { useAuth } from "@/lib/auth-context";
import { supabase } from "@/integrations/supabase/client";
import { profileLengthProblem } from "@/lib/validation";
import { ProfileForm } from "@/components/profile/ProfileForm";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

export const Route = createFileRoute("/app/profile")({
  component: ProfilePage,
});

function ProfilePage() {
  const { user } = useAuth();
  // Load the profile once per signed-in user, not again whenever the auth library hands over
  // a fresh copy of the same user (it does on every return to the tab): that reload used to
  // overwrite what had been typed but not yet saved.
  const userId = user?.id;
  const [name, setName] = useState("");
  const [role, setRole] = useState("Professional");
  const [goals, setGoals] = useState("");
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!userId) return;
    supabase
      .from("profiles")
      .select("name, role, goals")
      .eq("id", userId)
      .maybeSingle()
      .then(({ data, error }) => {
        if (error) toast.error(error.message);
        if (data) {
          setName(data.name ?? "");
          setRole(data.role ?? "Professional");
          setGoals(data.goals ?? "");
        }
        setLoaded(true);
      });
  }, [userId]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!user) return;
    const tooLong = profileLengthProblem({ name, role, goals });
    if (tooLong) {
      toast.error(tooLong);
      return;
    }
    setSaving(true);
    const { error } = await supabase.from("profiles").upsert({
      id: user.id, name, role, goals, updated_at: new Date().toISOString(),
    });
    setSaving(false);
    if (error) toast.error(error.message);
    else toast.success("Profile updated");
  };

  if (!loaded) return <div className="p-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;

  return (
    <div className="max-w-xl mx-auto px-6 py-10">
      <div className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">Profile</div>
      <h1 className="text-2xl font-semibold tracking-tight mt-1">Your context</h1>
      <p className="text-sm text-muted-foreground mt-1">Updates here change how MONDAY ranks your day.</p>

      <ProfileForm
        name={name} role={role} goals={goals}
        onNameChange={setName} onRoleChange={setRole} onGoalsChange={setGoals}
        saving={saving} onSubmit={save}
      />

      <div className="mt-10 rounded-lg border border-border bg-card p-5">
        <h2 className="text-sm font-semibold">Connections</h2>
        <p className="text-xs text-muted-foreground mt-1">
          Connect Gmail and Google Calendar, or keep using the demo inbox and calendar.
        </p>
        <Link to="/onboarding/connectors" className="mt-3 inline-flex text-sm font-medium text-primary hover:underline">
          Manage Google connection →
        </Link>
      </div>
    </div>
  );
}
