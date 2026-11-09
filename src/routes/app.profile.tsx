import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { useAuth } from "@/lib/auth-context";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

export const Route = createFileRoute("/app/profile")({
  component: ProfilePage,
});

function ProfilePage() {
  const { user } = useAuth();
  const [name, setName] = useState("");
  const [role, setRole] = useState("Professional");
  const [goals, setGoals] = useState("");
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!user) return;
    supabase
      .from("profiles")
      .select("name, role, goals")
      .eq("id", user.id)
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
  }, [user]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!user) return;
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

      <form onSubmit={save} className="mt-8 space-y-5">
        <div>
          <label className="block text-xs font-medium mb-1.5">Name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} required
                 className="w-full rounded-md border border-input bg-card px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
        </div>
        <div>
          <label className="block text-xs font-medium mb-1.5">Role</label>
          <select value={role} onChange={(e) => setRole(e.target.value)}
                  className="w-full rounded-md border border-input bg-card px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring">
            {["Student", "Professional", "Founder", "Other"].map((r) => <option key={r}>{r}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium mb-1.5">Goals</label>
          <textarea value={goals} onChange={(e) => setGoals(e.target.value)} rows={4} required
                    className="w-full rounded-md border border-input bg-card px-3 py-2.5 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-ring" />
        </div>
        <button type="submit" disabled={saving}
                className="inline-flex items-center gap-2 rounded-md bg-gradient-brand px-4 py-2.5 text-sm font-medium text-primary-foreground shadow-elev hover:opacity-95 transition disabled:opacity-60">
          {saving && <Loader2 className="h-4 w-4 animate-spin" />} Save changes
        </button>
      </form>

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
