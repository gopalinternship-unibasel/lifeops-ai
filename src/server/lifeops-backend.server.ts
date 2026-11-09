/**
 * Server-only client for the team's FastAPI planning service (fastapi-backend/, see its
 * frontend_contract.md). The browser never calls it directly: server functions forward
 * requests with the signed-in user's id (X-LifeOps-User) and the shared secret
 * (LIFEOPS_BACKEND_TOKEN), so each MONDAY user has a separate planner workspace.
 *
 * LIFEOPS_BACKEND_URL defaults to http://127.0.0.1:8010; set it to "off" to disable the
 * service and always use the in-app assistant.
 */
import { isRecord } from "@/lib/errors";

export class BackendUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackendUnavailableError";
  }
}

export interface BackendTask {
  id: number;
  title: string;
  description: string | null;
  deadline: string | null;
  estimated_minutes: number;
  priority: number;
  status: "pending" | "in_progress" | "done";
  source: string;
  created_at: string;
}

export interface BackendAction {
  id: number;
  action_type: "task" | "calendar_block" | "email_draft" | "reminder";
  title: string;
  description: string | null;
  start_time: string | null;
  end_time: string | null;
  email_to: string | null;
  email_subject: string | null;
  email_body: string | null;
  risk_level: "low" | "medium" | "high";
  requires_approval: boolean;
  status: "pending" | "approved" | "executed" | "rejected" | "failed";
  provider: string | null;
  external_id: string | null;
  execution_result: string | null;
  created_at: string;
  executed_at: string | null;
}

export interface BackendDashboard {
  before: { label: string; description: string };
  after: { label: string; description: string };
  metrics: {
    total_tasks: number;
    pending_tasks: number;
    done_tasks: number;
    total_actions: number;
    pending_actions: number;
    approved_actions: number;
    executed_actions: number;
  };
  last_plan: { summary: string; planner: string; created_at: string } | null;
  next_best_actions: BackendTask[];
  tasks: BackendTask[];
  actions: BackendAction[];
}

export interface BackendPlanResponse {
  plan_run_id: number;
  summary: string;
  tasks_created: number;
  actions_created: number;
  executed_safe_actions: number;
  planner: "llm" | "demo";
  planner_note: string | null;
}

export function backendBaseUrl(env: Record<string, string | undefined> = process.env): string | null {
  const raw = env.LIFEOPS_BACKEND_URL?.trim();
  if (raw === "off" || raw === "false" || raw === "0") return null;
  return (raw || "http://127.0.0.1:8010").replace(/\/+$/, "");
}

export function planTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const explicit = Number.parseInt(env.LIFEOPS_BACKEND_TIMEOUT_MS ?? "", 10);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  // The service may wait for the same LLM the app uses; allow the LLM timeout plus headroom.
  const llm = Number.parseInt(env.LLM_TIMEOUT_MS ?? "", 10);
  return (Number.isFinite(llm) && llm > 0 ? llm : 120_000) + 30_000;
}

export async function backendRequest<T>(
  path: string,
  opts: { userId: string; method?: "GET" | "POST"; body?: unknown; timeoutMs?: number },
): Promise<T> {
  const base = backendBaseUrl();
  if (!base) throw new BackendUnavailableError("The planner service is switched off (LIFEOPS_BACKEND_URL=off).");
  const headers: Record<string, string> = { "X-LifeOps-User": opts.userId, Accept: "application/json" };
  const token = process.env.LIFEOPS_BACKEND_TOKEN?.trim();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method: opts.method ?? "GET",
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 5_000),
    });
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new BackendUnavailableError(`The planner service at ${base} is not reachable (${reason}).`);
  }
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? (JSON.parse(text) as unknown) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const detail = isRecord(json) && typeof json.detail === "string" ? json.detail : text.slice(0, 200);
    if (res.status === 401) {
      throw new BackendUnavailableError(`The planner service rejected MONDAY's token (${detail}). Check LIFEOPS_BACKEND_TOKEN.`);
    }
    throw new Error(`Planner service: ${detail || `HTTP ${res.status}`}`);
  }
  return json as T;
}

export const backend = {
  dashboard: (userId: string) => backendRequest<BackendDashboard>("/api/dashboard", { userId, timeoutMs: 4_000 }),
  plan: (userId: string, body: { user_input: string; current_datetime: string; timezone: string }) =>
    backendRequest<BackendPlanResponse>("/api/plan", {
      userId,
      method: "POST",
      body: { ...body, autonomous_mode: false },
      timeoutMs: planTimeoutMs(),
    }),
  action: (userId: string, id: number) => backendRequest<BackendAction>(`/api/actions/${id}`, { userId }),
  approve: (userId: string, id: number) =>
    backendRequest<BackendAction>(`/api/actions/${id}/approve`, { userId, method: "POST" }),
  reject: (userId: string, id: number) =>
    backendRequest<BackendAction>(`/api/actions/${id}/reject`, { userId, method: "POST" }),
  recordExecution: (
    userId: string,
    id: number,
    outcome: { provider: string; external_id: string | null; result: Record<string, unknown> },
  ) => backendRequest<{ status: string }>(`/api/actions/${id}/execute`, { userId, method: "POST", body: outcome }),
  completeTask: (userId: string, id: number) =>
    backendRequest<BackendTask>(`/api/tasks/${id}/done`, { userId, method: "POST" }),
};
