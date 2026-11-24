/**
 * Server-only client for the team's FastAPI planning service (fastapi-backend/, see its
 * frontend_contract.md). The browser never calls it directly: server functions forward
 * requests with the signed-in user's id (X-LifeOps-User) and the shared secret
 * (LIFEOPS_BACKEND_TOKEN), so each MONDAY user has a separate planner workspace.
 *
 * LIFEOPS_BACKEND_URL defaults to http://127.0.0.1:8010 for a local run; a hosted site without
 * the setting treats the service as switched off. Set it to "off" to always use the in-app
 * assistant.
 *
 * Error messages are shown to the person using the app. On the hosted demo they never contain
 * the service's address, setting names or the service's raw answer; those go to the server log.
 * A local run keeps the developer wording, because the reader there is the one who can fix it.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database } from "@/integrations/supabase/types";
import { isRecord } from "@/lib/errors";
import type { PlanRequestRow } from "@/lib/plan-request";
import { isHostedDeployment } from "@/server/deployment.server";
import { capToHostLimit } from "@/server/host-limit.server";
import { enforceAiAllowance } from "@/server/limits.server";
import { dbError, describeCause } from "@/server/public-error.server";
import { localDateTime, normalizeTimeZone } from "@/server/timezone.server";

/**
 * Why the planner service could not be used: switched off or not set up ("off"), no connection
 * ("unreachable"), no answer in time ("timeout"), the service refused MONDAY's token
 * ("rejected"), or it answered with a server error or something that is not its JSON ("failed").
 * Each of these sends "Plan it" to the in-app assistant instead.
 */
export type BackendUnavailableReason = "off" | "unreachable" | "timeout" | "rejected" | "failed";

export class BackendUnavailableError extends Error {
  constructor(
    message: string,
    readonly reason: BackendUnavailableReason = "failed",
  ) {
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

/** A time the user's calendar is taken, as the planner reads it: local wall-clock times, no offset. */
export interface PlannerBusyInterval {
  title: string;
  start: string;
  end: string;
}

type Env = Record<string, string | undefined>;

function isSwitchedOff(raw: string | undefined): boolean {
  return raw === "off" || raw === "false" || raw === "0";
}

/**
 * The planner's base URL, or null when it is switched off. The 127.0.0.1 default is only for a
 * local run: on the hosted demo an unset URL would point at the host itself, so it means "off".
 */
export function backendBaseUrl(env: Env = process.env, hosted: boolean = isHostedDeployment(undefined, env)): string | null {
  const raw = env.LIFEOPS_BACKEND_URL?.trim();
  if (isSwitchedOff(raw)) return null;
  if (!raw && hosted) return null;
  return (raw || "http://127.0.0.1:8010").replace(/\/+$/, "");
}

export function planTimeoutMs(env: Env = process.env): number {
  const explicit = Number.parseInt(env.LIFEOPS_BACKEND_TIMEOUT_MS ?? "", 10);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  // The service may wait for the same LLM the app uses; allow the LLM timeout plus headroom.
  const llm = Number.parseInt(env.LLM_TIMEOUT_MS ?? "", 10);
  return (Number.isFinite(llm) && llm > 0 ? llm : 120_000) + 30_000;
}

/**
 * Timeout for the planner's quick calls (dashboard read, approve, reject and so on).
 * LIFEOPS_BACKEND_DASHBOARD_TIMEOUT_MS; default 10 s, because a planner that was idle on a
 * serverless host needs a cold start and a first database connection.
 */
export function quickTimeoutMs(env: Env = process.env): number {
  const explicit = Number.parseInt(env.LIFEOPS_BACKEND_DASHBOARD_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(explicit) && explicit > 0 ? explicit : 10_000;
}

/**
 * The longest any hosted edition lets one request run: Vercel Hobby ends a function after
 * 300 s (VERCEL_DEPLOYMENT.md, section 9). The Pages edition's Edge Function stops earlier and
 * says so with LIFEOPS_MAX_REQUEST_MS, which still applies on top of this.
 */
export const HOSTED_REQUEST_LIMIT_MS = 300_000;

/**
 * How long a "Plan it" request may stay "running" before the page calls it interrupted: the
 * planner's timeout, then the in-app assistant's chat turn, plus a minute for the database work.
 * A hosted function that runs out of time is ended by its host, so the window never goes past
 * the host's limit (a request cut off there would otherwise keep showing "Planning…" and block
 * "Plan it" for up to a minute longer).
 */
export function planRequestWindowMs(
  planMs: number,
  chatTurnMs: number,
  env: Env = process.env,
  hosted: boolean = isHostedDeployment(undefined, env),
): number {
  const total = planMs + chatTurnMs + 60_000;
  return capToHostLimit(hosted ? Math.min(total, HOSTED_REQUEST_LIMIT_MS) : total, env);
}

/**
 * When the planner should stop trying: a few seconds before this app stops waiting for it.
 * A planner that honours it stores nothing it finishes later, so the in-app assistant that
 * takes over does not leave a second set of proposals for the same request.
 */
export function planDeadlineIso(nowMs: number = Date.now(), timeoutMs: number = planTimeoutMs()): string {
  const margin = Math.min(3_000, Math.floor(timeoutMs / 2));
  return new Date(nowMs + timeoutMs - margin).toISOString();
}

/** "2026-11-25T10:00:00": the wall-clock time of an instant in a zone, as the planner reads times. */
function plannerLocalTime(iso: string, timeZone: string): string | null {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const local = localDateTime(ms, timeZone);
  return `${local.date}T${local.hhmm}:00`;
}

/** The most busy intervals one plan request sends (the planner accepts up to 200). */
export const MAX_BUSY_INTERVALS = 200;

/**
 * The user's busy calendar times for the planner, so it does not propose blocks on top of them.
 * Free ("show as free") events and events without a valid time are left out; titles are cut to
 * the planner's 200 characters.
 */
export function busyForPlanner(
  events: Array<{ title: string; starts_at: string; ends_at: string; busy?: boolean }>,
  timeZone: string,
): PlannerBusyInterval[] {
  const zone = normalizeTimeZone(timeZone);
  return events
    .filter((event) => event.busy !== false && Date.parse(event.ends_at) > Date.parse(event.starts_at))
    .sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at))
    .slice(0, MAX_BUSY_INTERVALS)
    .flatMap((event) => {
      const start = plannerLocalTime(event.starts_at, zone);
      const end = plannerLocalTime(event.ends_at, zone);
      return start && end ? [{ title: (event.title ?? "").trim().slice(0, 200), start, end }] : [];
    });
}

/** The most planner tasks and actions the dashboard asks for (the planner may ignore it). */
export const PLANNER_DASHBOARD_LIMIT = 50;

/**
 * Open items first, in the planner's own order: actions that still wait for the user (pending,
 * approved, failed) before finished ones (executed, rejected); tasks not yet done before done
 * ones. An unknown status goes last.
 */
const ACTION_STATUS_ORDER = ["pending", "approved", "failed", "executed", "rejected"];
const TASK_STATUS_ORDER = ["pending", "in_progress", "done"];

function statusRank(order: string[], status: unknown): number {
  const index = typeof status === "string" ? order.indexOf(status) : -1;
  return index === -1 ? order.length : index;
}

/**
 * At most `limit` items, open ones first and the newest first within a status. Cutting by id alone
 * dropped an older action that still waited for approval while newer finished ones were kept.
 */
function openFirst<T extends { id: number; status: string }>(items: unknown, limit: number, order: string[]): T[] {
  if (!Array.isArray(items)) return [];
  return (items.filter((item) => isRecord(item) && typeof item.id === "number") as T[])
    .sort((a, b) => statusRank(order, a.status) - statusRank(order, b.status) || b.id - a.id)
    .slice(0, limit);
}

/**
 * The planner's dashboard, bounded to `limit` tasks and actions, open ones first (as the planner
 * orders them itself). An older planner ignores the limit parameter and sends its whole history;
 * the page never needs more than this. The metrics keep the planner's totals. An answer without
 * the dashboard's lists is not the planner's: it counts as unavailable.
 */
export function boundPlannerDashboard(value: unknown, limit: number = PLANNER_DASHBOARD_LIMIT): BackendDashboard {
  if (!isRecord(value) || !Array.isArray(value.actions) || !Array.isArray(value.tasks)) {
    throw new BackendUnavailableError(unavailableMessage("an answer without the dashboard"), "failed");
  }
  const metrics = isRecord(value.metrics) ? value.metrics : {};
  const count = (key: string) => (typeof metrics[key] === "number" ? (metrics[key] as number) : 0);
  const lastPlan = isRecord(value.last_plan) && typeof value.last_plan.summary === "string" ? value.last_plan : null;
  return {
    before: value.before as BackendDashboard["before"],
    after: value.after as BackendDashboard["after"],
    metrics: {
      total_tasks: count("total_tasks"),
      pending_tasks: count("pending_tasks"),
      done_tasks: count("done_tasks"),
      total_actions: count("total_actions"),
      pending_actions: count("pending_actions"),
      approved_actions: count("approved_actions"),
      executed_actions: count("executed_actions"),
    },
    last_plan: lastPlan as BackendDashboard["last_plan"],
    // The planner sorts these by priority; keep its order, only bounded.
    next_best_actions: (Array.isArray(value.next_best_actions) ? value.next_best_actions : [])
      .filter((task): task is BackendTask => isRecord(task) && typeof task.id === "number")
      .slice(0, limit),
    tasks: openFirst<BackendTask>(value.tasks, limit, TASK_STATUS_ORDER),
    actions: openFirst<BackendAction>(value.actions, limit, ACTION_STATUS_ORDER),
  };
}

/* ------------------------------------------------------------------------------------------
 * Messages
 * ---------------------------------------------------------------------------------------- */

function unavailableMessage(localDetail: string): string {
  return isHostedDeployment()
    ? "The planner service is not available right now."
    : `The planner service is not available (${localDetail}). See its log.`;
}

function offMessage(env: Env = process.env): string {
  if (!isHostedDeployment(undefined, env)) return "The planner service is switched off (LIFEOPS_BACKEND_URL=off).";
  return isSwitchedOff(env.LIFEOPS_BACKEND_URL?.trim())
    ? "The planner service is switched off on this site."
    : "The planner service is not set up on this site.";
}

/** The error "Plan it" gets when the planner is switched off: the in-app assistant takes over. */
export function backendOffError(env: Env = process.env): BackendUnavailableError {
  return new BackendUnavailableError(offMessage(env), "off");
}

/** A FastAPI "detail" that reads as a sentence, or "" (lists, JSON, HTML and long text are not shown). */
function readableDetail(json: unknown): string {
  if (!isRecord(json) || typeof json.detail !== "string") return "";
  const line = json.detail.replace(/\s+/g, " ").trim();
  if (!line || line.length > 160 || /^[[{<]/.test(line)) return "";
  return line.replace(/\.$/, "");
}

function logPlannerFailure(what: string, detail: string): void {
  console.error(`[lifeops] planner ${what}: ${detail}`);
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

export async function backendRequest<T>(
  path: string,
  opts: { userId: string; method?: "GET" | "POST"; body?: unknown; timeoutMs?: number },
): Promise<T> {
  const base = backendBaseUrl();
  if (!base) throw backendOffError();
  const what = `${opts.method ?? "GET"} ${path.replace(/\?.*$/, "")}`;
  const headers: Record<string, string> = { "X-LifeOps-User": opts.userId, Accept: "application/json" };
  const token = process.env.LIFEOPS_BACKEND_TOKEN?.trim();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const timeoutMs = opts.timeoutMs ?? quickTimeoutMs();
  const hosted = isHostedDeployment();

  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method: opts.method ?? "GET",
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error: unknown) {
    logPlannerFailure(what, `${base}: ${describeCause(error)}`);
    if (isTimeout(error)) {
      // It was reachable but slow: say so, without the service's address.
      throw new BackendUnavailableError(
        `The planner service did not answer within ${Math.round(timeoutMs / 1000)} s.`,
        "timeout",
      );
    }
    const reason = error instanceof Error ? error.message : String(error);
    throw new BackendUnavailableError(
      hosted
        ? "The planner service could not be reached."
        : `The planner service at ${base} is not reachable (${reason}). Start it or set LIFEOPS_BACKEND_URL=off.`,
      "unreachable",
    );
  }

  const text = await res.text().catch(() => "");
  let json: unknown = null;
  try {
    json = text ? (JSON.parse(text) as unknown) : null;
  } catch {
    json = null;
  }
  const isJson = isRecord(json) || Array.isArray(json);

  if (!res.ok) {
    logPlannerFailure(what, `HTTP ${res.status}: ${text.replace(/\s+/g, " ").slice(0, 500)}`);
    if (res.status === 401 || res.status === 403) {
      // Without a token nothing was "rejected": the service is not set up for this app.
      throw new BackendUnavailableError(
        hosted
          ? "The planner service is not set up correctly for this site."
          : token
            ? "The planner service rejected MONDAY's token. Check that LIFEOPS_BACKEND_TOKEN matches the planner's token."
            : "The planner service needs a token: set LIFEOPS_BACKEND_TOKEN to the planner's token.",
        "rejected",
      );
    }
    const detail = readableDetail(json);
    // The service's own refusals ("Action is already approved", "Action not found") are JSON with a
    // sentence; anything else (a crash, a gateway or platform page, an unknown route) means the
    // service is not usable right now, and "Plan it" falls back to the in-app assistant.
    const serviceRefusal =
      res.status >= 400 && res.status < 500 && ![404, 405, 408, 429].includes(res.status) && isJson;
    const appNotFound = res.status === 404 && detail !== "" && detail.toLowerCase() !== "not found";
    if (serviceRefusal || appNotFound) {
      throw new Error(
        detail
          ? `The planner service could not do this: ${detail}.`
          : "The planner service could not accept this request.",
      );
    }
    throw new BackendUnavailableError(unavailableMessage(`HTTP ${res.status}`), "failed");
  }
  if (!isJson) {
    logPlannerFailure(what, `HTTP ${res.status} without JSON: ${text.replace(/\s+/g, " ").slice(0, 200)}`);
    throw new BackendUnavailableError(unavailableMessage("an answer that is not JSON"), "failed");
  }
  return json as T;
}

/** A /api/plan answer the dashboard can store; anything else counts as the service failing. */
function checkedPlanResponse(value: BackendPlanResponse): BackendPlanResponse {
  if (
    !isRecord(value) ||
    typeof value.summary !== "string" ||
    typeof value.tasks_created !== "number" ||
    typeof value.actions_created !== "number"
  ) {
    logPlannerFailure("POST /api/plan", "an answer without summary or counts");
    throw new BackendUnavailableError(unavailableMessage("an answer without a plan"), "failed");
  }
  return value;
}

export const backend = {
  dashboard: async (userId: string) =>
    boundPlannerDashboard(
      await backendRequest<unknown>(`/api/dashboard?limit=${PLANNER_DASHBOARD_LIMIT}`, {
        userId,
        timeoutMs: quickTimeoutMs(),
      }),
    ),
  plan: async (
    userId: string,
    body: { user_input: string; current_datetime: string; timezone: string; busy?: PlannerBusyInterval[] },
  ) => {
    const timeoutMs = planTimeoutMs();
    return checkedPlanResponse(
      await backendRequest<BackendPlanResponse>("/api/plan", {
        userId,
        method: "POST",
        body: { ...body, busy: body.busy ?? [], autonomous_mode: false, deadline: planDeadlineIso(Date.now(), timeoutMs) },
        timeoutMs,
      }),
    );
  },
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

/* ------------------------------------------------------------------------------------------
 * "Plan it" requests (table public.planner_requests)
 * ---------------------------------------------------------------------------------------- */

/** The refusal for a second "Plan it" while one is still running. */
export const PLAN_ALREADY_RUNNING =
  "A “Plan it” request is already running. Its result appears on this page when it is ready.";

/** Stored for a request that was cut off before it finished (for example by a server restart). */
export const INTERRUPTED_TEXT = "The request was cut off before it finished, for example by a server restart.";

const REQUEST_COLUMNS = "id, input, status, result, error, created_at, finished_at";

/**
 * Store a new "Plan it" request as running, one at a time per user: a second tab used to start a
 * second planner run (and spend a second AI request).
 *
 * Every request records one "planner" use of the demo's AI allowance (off unless the AI_*
 * settings are set), after the checks and before the row is stored, so a refused request leaves
 * no row. That holds whether the planner service or the in-app assistant answers it: the
 * assistant's chat turn only checks the chat allowance and records no use of its own, so a press
 * with the planner switched off was not counted at all. `enforceAllowance` is for tests.
 *
 * A request the host cut off is still "running" in the table, although the page shows it as
 * interrupted once `windowMs` has passed; it is closed first. Without that, the unique index on
 * running requests would refuse every new one. That index also closes the gap between the check
 * here and the insert: its unique violation (23505) gives the same refusal.
 */
export async function startPlanRequest(
  supabase: SupabaseClient<Database>,
  userId: string,
  input: string,
  opts: { windowMs: number; nowMs?: number; enforceAllowance?: typeof enforceAiAllowance },
): Promise<PlanRequestRow> {
  const now = opts.nowMs ?? Date.now();
  const cutoff = new Date(now - opts.windowMs).toISOString();
  const { error: closeError } = await supabase
    .from("planner_requests")
    .update({ status: "failed", error: INTERRUPTED_TEXT, finished_at: new Date(now).toISOString() })
    .eq("user_id", userId)
    .eq("status", "running")
    .lt("created_at", cutoff);
  if (closeError) console.error("[lifeops] Plan it: could not close interrupted requests:", describeCause(closeError));

  const { data: running, error: runningError } = await supabase
    .from("planner_requests")
    .select("id")
    .eq("user_id", userId)
    .eq("status", "running")
    .gte("created_at", cutoff)
    .limit(1)
    .maybeSingle();
  if (runningError) throw dbError("check your running plan request", runningError);
  if (running) throw new Error(PLAN_ALREADY_RUNNING);

  await (opts.enforceAllowance ?? enforceAiAllowance)(supabaseAdmin, userId, "planner");

  const { data: row, error: insertError } = await supabase
    .from("planner_requests")
    .insert({ user_id: userId, input, status: "running" })
    .select(REQUEST_COLUMNS)
    .single();
  if (insertError) {
    if (insertError.code === "23505") throw new Error(PLAN_ALREADY_RUNNING);
    throw dbError("start the plan request", insertError);
  }
  return row;
}

/* ------------------------------------------------------------------------------------------
 * Texts stored with a "Plan it" request
 * ---------------------------------------------------------------------------------------- */

/** Planner state for the dashboard badge and the action approval center. */
export interface PlannerOffline {
  reason: BackendUnavailableReason;
  error: string;
}

/** Why the planner's dashboard could not be read, in words for the visitor. */
export function plannerOfflineFrom(error: unknown): PlannerOffline {
  if (error instanceof BackendUnavailableError) return { reason: error.reason, error: error.message };
  if (error instanceof Error && error.message && error.constructor === Error) {
    return { reason: "failed", error: error.message };
  }
  console.error("[lifeops] planner dashboard:", describeCause(error));
  return { reason: "failed", error: "The planner service is not available right now." };
}

/** Developer or parser text that must not be shown to a visitor. */
const INTERNAL_TEXT =
  /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b|https?:\/\/|localhost|127\.0\.0\.1|\[::1\]|docker|Traceback|\bExpecting\b|line \d+ column \d+|\(char \d+\)|index out of range|NoneType|KeyError|object has no attribute|validation errors? for|[{}<>]/;

/**
 * A planner note that is safe to show. Notes about what the planner changed ("Dropped calendar
 * block ...") stay; a note that carries parser output or setting names ("Expecting ','
 * delimiter: line 1 column 50", "LLM_BASE_URL unset") becomes a plain sentence, and the detail
 * stays in the planner's own log.
 */
export function safePlannerNote(note: string | null | undefined): string | null {
  const text = (note ?? "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  if (!INTERNAL_TEXT.test(text)) return text.slice(0, 600);
  if (/^No LLM configured\b/i.test(text)) {
    return "No AI model is set up for the planner, so the keyword planner made this plan.";
  }
  if (/^The LLM planner failed\b/i.test(text)) {
    return "The AI planner's answer could not be used this time, so the keyword planner made this plan.";
  }
  const kept = text.split(/(?<=\.)\s+/).filter((sentence) => !INTERNAL_TEXT.test(sentence));
  return kept.length ? kept.join(" ").slice(0, 600) : null;
}

/**
 * On the hosted demo: `fallback` instead of a stored text that carries developer details
 * (addresses, setting names, docker hints, raw service answers). Requests stored before these
 * texts were cleaned up still hold them. A local run shows the text as it is.
 */
export function visitorSafeText(text: string, fallback: string, hosted: boolean = isHostedDeployment()): string {
  if (!hosted) return text;
  return INTERNAL_TEXT.test(text) ? fallback : text;
}
