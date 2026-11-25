import type { FormEvent, KeyboardEvent } from "react";
import { ArrowRight, Loader2 } from "lucide-react";
import { TEXT_LIMITS } from "@/lib/validation";

const ROLES = ["Student", "Professional", "Founder", "Other"];

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
