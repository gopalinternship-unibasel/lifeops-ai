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

/** The banner the plan page shows for the newest request of the week, if any. */
export type PlanRequestBanner = "running" | "interrupted" | "failed" | null;

/**
 * Which banner to show. A failed or cut-off request shows until the visitor closes it (`hidden`)
 * or a later request replaces it as the newest one (a later success shows no banner). While the
 * page waits for its own draft, the older outcome is not shown, so it does not read as this
 * attempt's.
 */
export function planRequestBanner(
  request: WeekPlanRequestView | null,
  opts: { loading: boolean; waitingHere: boolean; hidden: ReadonlySet<string> },
): PlanRequestBanner {
  if (opts.loading || !request) return null;
  if (request.status === "running") return "running";
  if (opts.waitingHere || opts.hidden.has(request.id)) return null;
  return request.status === "failed" || request.status === "interrupted" ? request.status : null;
}

/**
 * After a draft call failed: true when the server stored no request for it (a refusal such as a
 * limit, a draft already running or the AI not being set up). The newest request is then still
 * the one from before, so its old failure is hidden and the reason is told in the chat instead.
 */
export function refusalStoredNoRequest(
  previousRequestId: string | null,
  latest: WeekPlanRequestView | null,
): boolean {
  return !latest || latest.id === previousRequestId;
}

/**
 * When a request started, for the banners: "3:14 PM" today, otherwise with the date
 * ("Mon, Nov 23, 3:14 PM"), so an old failure does not read as if it had just happened.
 * Local time of the browser.
 */
export function formatRequestTime(iso: string, now: Date = new Date()): string {
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return "";
  if (at.toDateString() === now.toDateString()) {
    return at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  }
  return at.toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(at.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
    hour: "numeric",
    minute: "2-digit",
  });
}
