/**
 * The week plan page's "Create plan" / refinement requests (table public.week_plan_requests),
 * shared by the server and the page. A request runs to the end on the server and stores the plan
 * and its outcome, so a page that was reloaded meanwhile shows "Drafting…" again, checks until
 * the request is done and then shows the plan (QA round 4: after a reload the page read "No plan
 * for this week yet" while the model was still drafting, and one real-model plan was lost).
 */
export interface WeekPlanRequestView {
  id: string;
  kind: "create" | "refine";
  /** "interrupted": still marked running, but older than a request can take (server restarted). */
  status: "running" | "done" | "failed" | "interrupted";
  startedAt: string;
  finishedAt: string | null;
  reply: string | null;
  error: string | null;
}

export interface WeekPlanRequestRow {
  id: string;
  kind: string;
  status: string;
  reply: string | null;
  error: string | null;
  created_at: string;
  finished_at: string | null;
}

/** What the page shows for a stored request; a "running" row older than maxRunMs was cut off. */
export function weekPlanRequestView(row: WeekPlanRequestRow, nowMs: number, maxRunMs: number): WeekPlanRequestView {
  const startedMs = Date.parse(row.created_at);
  const status: WeekPlanRequestView["status"] =
    row.status === "done" || row.status === "failed"
      ? row.status
      : Number.isFinite(startedMs) && nowMs - startedMs > maxRunMs
        ? "interrupted"
        : "running";
  return {
    id: row.id,
    kind: row.kind === "refine" ? "refine" : "create",
    status,
    startedAt: row.created_at,
    finishedAt: row.finished_at,
    reply: status === "done" ? row.reply : null,
    error: status === "failed" ? (row.error ?? "Drafting the plan failed.") : null,
  };
}
