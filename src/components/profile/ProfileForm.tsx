import type { FormEvent } from "react";
import { Loader2 } from "lucide-react";
import { TEXT_LIMITS } from "@/lib/validation";

const ROLES = ["Student", "Professional", "Founder", "Other"];

/**
 * The profile fields. Each label is tied to its control (htmlFor/id), so screen readers name
 * the fields and a click on a label focuses them; maxLength keeps each text within what the
 * database accepts (TEXT_LIMITS).
 */
export function ProfileForm({
  name, role, goals, onNameChange, onRoleChange, onGoalsChange, saving, onSubmit,
}: {
  name: string;
  role: string;
  goals: string;
  onNameChange: (value: string) => void;
  onRoleChange: (value: string) => void;
  onGoalsChange: (value: string) => void;
  saving: boolean;
  onSubmit: (e: FormEvent) => void;
}) {
  return (
    <form onSubmit={onSubmit} className="mt-8 space-y-5">
      <div>
        <label htmlFor="profile-name" className="block text-xs font-medium mb-1.5">Name</label>
        <input id="profile-name" value={name} onChange={(e) => onNameChange(e.target.value)} required
               maxLength={TEXT_LIMITS.profileName}
               className="w-full rounded-md border border-input bg-card px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
      </div>
      <div>
        <label htmlFor="profile-role" className="block text-xs font-medium mb-1.5">Role</label>
        <select id="profile-role" value={role} onChange={(e) => onRoleChange(e.target.value)}
                className="w-full rounded-md border border-input bg-card px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring">
          {ROLES.map((r) => <option key={r}>{r}</option>)}
        </select>
      </div>
      <div>
        <label htmlFor="profile-goals" className="block text-xs font-medium mb-1.5">Goals</label>
        <textarea id="profile-goals" value={goals} onChange={(e) => onGoalsChange(e.target.value)} rows={4} required
                  maxLength={TEXT_LIMITS.profileGoals}
                  className="w-full rounded-md border border-input bg-card px-3 py-2.5 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-ring" />
      </div>
      <button type="submit" disabled={saving}
              className="inline-flex items-center gap-2 rounded-md bg-gradient-brand px-4 py-2.5 text-sm font-medium text-primary-foreground shadow-elev hover:opacity-95 transition disabled:opacity-60">
        {saving && <Loader2 className="h-4 w-4 animate-spin" />} Save changes
      </button>
    </form>
  );
}
