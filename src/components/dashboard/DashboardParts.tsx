/**
 * Small parts of the dashboard page (src/routes/app.dashboard.tsx). They live outside the route
 * file so they can be rendered in tests, and so the route file exports only its route (TanStack's
 * automatic code splitting cannot split other exports of a route file).
 */
import { Loader2 } from "lucide-react";
import { cleanRecipientInput } from "@/lib/dashboard-view";

/** A first load that failed: the reason and Try again, instead of a spinner that never ends. */
export function DashboardLoadError({ message, onRetry }: { message: string | null; onRetry: () => void }) {
  return (
    <div role="alert" className="grid place-items-center gap-3 px-4 py-24 text-center text-sm" data-testid="dashboard-load-error">
      <p className="max-w-md text-muted-foreground">{message ?? "Could not load the dashboard."}</p>
      <button
        type="button"
        onClick={onRetry}
        className="rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted"
      >
        Try again
      </button>
    </div>
  );
}

/** The To field of a planner email draft; line breaks and tabs become spaces as they are typed. */
export function RecipientField({ value, onChange, disabled, testId }: {
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  testId?: string;
}) {
  return (
    <label className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
      <span className="shrink-0">To</span>
      <input
        type="text"
        inputMode="email"
        autoComplete="email"
        value={value}
        onChange={(e) => onChange(cleanRecipientInput(e.target.value))}
        maxLength={320}
        placeholder="recipient to fill in"
        disabled={disabled}
        data-testid={testId}
        className="min-w-0 flex-1 rounded-md border border-input bg-background px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
      />
    </label>
  );
}

/**
 * A planner task's Done button. While it runs it shows a spinner, so its name comes from
 * aria-label (a screen reader would otherwise announce an unnamed button).
 */
export function TaskDoneButton({ busy, onClick }: { busy: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} disabled={busy} aria-label="Done" aria-busy={busy || undefined}
      className="shrink-0 text-[11px] rounded-md border border-border px-2 py-1 hover:bg-muted disabled:opacity-60">
      {busy ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> : "Done"}
    </button>
  );
}
