/**
 * The dashboard's "Plan it" requests (table public.planner_requests), shared by the server and
 * the page. A request runs to the end on the server and stores its result, so a page that was
 * reloaded meanwhile can show "Planning…" again and then the result.
 */
import type { PanelPayload } from "@/types/panel";
import { isRecord } from "@/lib/errors";

export type PlanRequestResult =
  | { mode: "service"; summary: string; planner: string; note: string | null; tasks: number; actions: number }
  | { mode: "in-app"; reason: string; reply: string; panel: PanelPayload };

export interface PlanRequestView {
  id: string;
  input: string;
  /** "interrupted": still marked running, but older than a request can take (server restarted). */
  status: "running" | "done" | "failed" | "interrupted";
  startedAt: string;
  finishedAt: string | null;
  result: PlanRequestResult | null;
  error: string | null;
}

export interface PlanRequestRow {
  id: string;
  input: string;
  status: string;
  result: unknown;
  error: string | null;
  created_at: string;
  finished_at: string | null;
}

function parseResult(value: unknown): PlanRequestResult | null {
  if (!isRecord(value)) return null;
  if (value.mode === "service" && typeof value.summary === "string") {
    return {
      mode: "service",
      summary: value.summary,
      planner: typeof value.planner === "string" ? value.planner : "demo",
      note: typeof value.note === "string" ? value.note : null,
      tasks: typeof value.tasks === "number" ? value.tasks : 0,
      actions: typeof value.actions === "number" ? value.actions : 0,
    };
  }
  if (value.mode === "in-app" && typeof value.reply === "string") {
    return {
      mode: "in-app",
      reason: typeof value.reason === "string" ? value.reason : "",
      reply: value.reply,
      panel: isRecord(value.panel) ? (value.panel as PanelPayload) : {},
    };
  }
  return null;
}

/** What the page shows for a stored request; a "running" row older than maxRunMs was cut off. */
export function planRequestView(row: PlanRequestRow, nowMs: number, maxRunMs: number): PlanRequestView {
  const startedMs = Date.parse(row.created_at);
  const status: PlanRequestView["status"] =
    row.status === "done" || row.status === "failed"
      ? row.status
      : Number.isFinite(startedMs) && nowMs - startedMs > maxRunMs
        ? "interrupted"
        : "running";
  return {
    id: row.id,
    input: row.input,
    status,
    startedAt: row.created_at,
    finishedAt: row.finished_at,
    result: status === "done" ? parseResult(row.result) : null,
    error: status === "failed" ? (row.error ?? "Planning failed.") : null,
  };
}
